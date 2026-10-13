'use strict';

const assert = require('node:assert/strict');
const { beforeEach, afterEach, test, mock } = require('node:test');
const care = require('../care_service');
const { handler } = require('../index');
const { extractSignalsFromText } = require('../tools/ingestBeeContext');
const { formatAlert } = require('../sns_notifier');

beforeEach(() => {
    care.resetMockRecords();
    mock.method(console, 'info', () => {});
});
afterEach(() => {
    mock.restoreAll();
    delete process.env.DEMO_OWNER_ID;
});

function request(name, slots = {}, attributes = {}, requestId = Math.random().toString(), screen = false) {
    const userId = 'ux-user';
    return {
        version: '1.0',
        session: { user: { userId }, application: { applicationId: 'test' }, attributes },
        context: { System: { user: { userId }, application: { applicationId: 'test' },
            device: { supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
        request: { type: 'IntentRequest', intent: { name, slots }, requestId,
            timestamp: new Date().toISOString(), locale: 'en-US' }
    };
}

function slot(name, value) { return { name, value }; }

test('two pending check-ins require selection before completion and never complete the other', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    const first = await care.createFollowup({ ...input, signal: 'sleep', dueDate: '2030-01-10', dueTime: '18:00' });
    const second = await care.createFollowup({ ...input, signal: 'mood', dueDate: '2030-01-11', dueTime: '18:00' });
    const prompt = await handler(request('CompleteFollowupIntent', { followupStatus: slot('followupStatus', 'better') }), {});
    assert.match(prompt.response.outputSpeech.ssml, /Which check-in/i);
    assert.equal((await care.listFollowups(input)).followups.length, 2);
    await handler(request('SelectFollowupIntent', { choice: slot('choice', '2') }, prompt.sessionAttributes), {});
    assert.equal((await care.getFollowupById({ ...input, followupId: first.followupId })).status, 'pending');
    assert.equal((await care.getFollowupById({ ...input, followupId: second.followupId })).status, 'completed');
    delete process.env.DEMO_OWNER_ID;
});

test('rescheduling moves the exact check-in and revokes the old sharing permission', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    const original = await care.createFollowup({ ...input, signal: 'sleep', dueDate: '2030-01-10', dueTime: '18:00' });
    await care.requestConsent({ ...input, caregiverName: 'Laura', signal: 'sleep', followupId: original.followupId });
    const result = await handler(request('RescheduleFollowupIntent', { followupTime: slot('followupTime', '20:00') }), {});
    assert.match(result.response.outputSpeech.ssml, /Sharing permission for the old time was withdrawn/i);
    const moved = await care.getFollowupById({ ...input, followupId: original.followupId });
    assert.equal(moved.dueTime, '20:00');
    assert.equal(moved.followupId, original.followupId);
    assert.equal(await care.findActiveConsent({ ...input, caregiverName: 'Laura', signal: 'sleep', followupId: original.followupId }), null);
    delete process.env.DEMO_OWNER_ID;
});

test('the last voice report can be corrected without creating a second report', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    const reported = await handler(request('ReportWellnessIntent', { sleepHours: slot('sleepHours', '6') }), {});
    const corrected = await handler(request('CorrectReportIntent', { sleepHours: slot('sleepHours', '7') }, reported.sessionAttributes), {});
    assert.match(corrected.response.outputSpeech.ssml, /corrected your last report/i);
    const history = await care.getWellnessHistory({ ...input, timeframe: 'today' });
    assert.equal(history.length, 1);
    assert.equal(history[0].numericValue, 7);
    delete process.env.DEMO_OWNER_ID;
});

test('a member correction moves the unscheduled report without duplicating it', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    const reported = await handler(request('ReportWellnessIntent', { wellnessSignal: slot('wellnessSignal', 'mood') }), {});
    const corrected = await handler(request('CorrectReportIntent', { memberName: slot('memberName', 'Maya') },
        reported.sessionAttributes), {});
    assert.match(corrected.response.outputSpeech.ssml, /corrected your last report/i);
    assert.equal((await care.getWellnessHistory({ ...input, timeframe: 'today' })).length, 0);
    assert.equal((await care.getWellnessHistory({ ...input, memberName: 'Maya', timeframe: 'today' })).length, 1);
});

test('discreet mode masks card and screen data while a requested voice summary remains available', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    await care.getCareContext(input);
    await care.updateCarePreferences({ ...input, discreetMode: 'on' });
    await care.logWellnessEvent({ ...input, signal: 'mood', state: 'reported' });
    const result = await handler(request('GetWellnessSummaryIntent', {}, {}, 'summary-private', true), {});
    assert.match(result.response.outputSpeech.ssml, /wellness reports/i);
    assert.doesNotMatch(result.response.card.content, /Elena|mood/i);
    const data = result.response.directives[0].datasources.wellnessData;
    assert.equal(data.memberName, 'CarePulse');
    assert.doesNotMatch(JSON.stringify(data), /Elena|Laura|reported/i);
    assert.equal(data.signals.mood.value, 'No data');
    assert.doesNotMatch(formatAlert({ memberName: 'Elena', signal: 'mood' }).message, /Elena|mood/i);
    delete process.env.DEMO_OWNER_ID;
});

test('Bee ignores negated and third-party signals without inferring intensity', () => {
    assert.deepEqual(extractSignalsFromText(['I am not tired', 'my brother is dizzy', 'I am tired'], 'Elena'),
        [{ signal: 'tiredness', intensity: 'reported', source: 'bee' }]);
    assert.deepEqual(extractSignalsFromText(['Elena felt completely exhausted', 'she was not dizzy'], 'Elena'),
        [{ signal: 'tiredness', intensity: 'high', source: 'bee' }]);
    assert.deepEqual(extractSignalsFromText(['I feel very tired and dizzy'], 'Elena'), [
        { signal: 'tiredness', intensity: 'moderate', source: 'bee' },
        { signal: 'dizziness', intensity: 'reported', source: 'bee' }
    ]);
});

test('appetite reports retain the direction of the original phrase', async () => {
    const input = { ownerId: 'ux-user', memberName: 'Elena' };
    process.env.DEMO_OWNER_ID = input.ownerId;
    const appetiteSlot = phrase => ({ name: 'wellnessSignal', value: phrase,
        resolutions: { resolutionsPerAuthority: [{ status: { code: 'ER_SUCCESS_MATCH' },
            values: [{ value: { name: 'appetite' } }] }] } });
    await handler(request('ReportWellnessIntent', { wellnessSignal: appetiteSlot('not hungry') }), {});
    await handler(request('ReportWellnessIntent', { wellnessSignal: appetiteSlot('hunger') }), {});
    const states = (await care.getWellnessHistory({ ...input, timeframe: 'today' })).map(item => item.state).sort();
    assert.deepEqual(states, ['less-than-usual', 'reported']);
});

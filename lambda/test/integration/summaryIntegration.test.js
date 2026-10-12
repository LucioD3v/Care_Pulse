'use strict';

const assert = require('node:assert/strict');
const { beforeEach, afterEach, test, mock } = require('node:test');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const care = require('../../care_service');
const repository = require('../../care_repository');
const { handler, _private } = require('../../index');
const { grantBeeConsent } = require('../../bee_link');
const { ingestBeeContext } = require('../../tools/ingestBeeContext');
const { addCareDashboard } = require('../../care_dashboard');

const environment = { ...process.env };
beforeEach(() => {
    for (const key of ['CARE_TABLE_NAME', 'DEMO_OWNER_ID', 'ALEXA_SKILL_ID']) delete process.env[key];
    repository.resetMockRecords();
    mock.method(console, 'info', () => {});
});
afterEach(() => {
    mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
});

function request(userId, timeframe = 'this week', screen = true) {
    return {
        version: '1.0',
        session: { application: { applicationId: 'test' }, user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
        request: { type: 'IntentRequest', requestId: 'summary-integration', timestamp: new Date().toISOString(),
            locale: 'en-US', intent: { name: 'GetWellnessSummaryIntent',
                slots: { timeframe: { name: 'timeframe', value: timeframe } } } }
    };
}

function member(event) {
    return { ownerId: _private.ownerId({ requestEnvelope: event }), memberName: 'Elena' };
}

async function summary(event) {
    const result = await handler(event, {});
    assert.match(result.response.outputSpeech.ssml, /summary/);
    assert.equal(result.response.directives.length, 1);
    const directive = result.response.directives[0];
    assert.equal(directive.token, 'wellnessSnapshot');
    return { data: directive.datasources.wellnessData, directive, response: result.response };
}

test('one summary integrates Bee signals with the previous dashboard and scoped sharing permission', async () => {
    const event = request('combined-summary');
    const input = member(event);
    const context = await care.getCareContext(input);
    await repository.updateRecord(context.pk, context.sk, { caregiverName: 'Laura <test>' });
    const { linkCode } = await grantBeeConsent(input);
    await ingestBeeContext({ linkCode, beeExport: {
        exportedAt: new Date(Date.now() - 60000).toISOString(),
        facts: [{ text: 'I feel very tired', confirmed: true }]
    } });
    await care.logWellnessEvent({ ...input, signal: 'mood', state: 'better' });
    const followup = await care.createFollowup({ ...input, signal: 'tiredness', dueDate: '2030-01-10', dueTime: '18:00' });
    await care.requestConsent({ ...input, caregiverName: 'Laura <test>', signal: 'tiredness', followupId: followup.followupId });

    const { data, directive } = await summary(event);
    assert.equal(data.hasBeeData, true);
    assert.equal(data.signals.energy.source, 'Bee 🐝');
    assert.equal(data.signals.mood.value, 'better');
    assert.match(data.dashboard.lastReport, /^mood on /);
    assert.equal(data.dashboard.nextFollowup, '2030-01-10 at 18:00');
    assert.equal(data.dashboard.permission, 'Active for Laura &lt;test&gt; on this follow-up');
    assert.equal(data.followupScheduled, true);
    assert.equal(data.caregiverAlerted, false);
    const scroll = directive.document.mainTemplate.item.items.find(item => item.type === 'ScrollView');
    assert.ok(scroll);
    const rendered = JSON.stringify(scroll);
    for (const field of ['lastReport', 'nextFollowup', 'permission']) {
        assert.ok(rendered.includes('wellnessData.dashboard.' + field));
    }
    assert.match(rendered, /SignalRow|BeeSourceBadge/);
});

test('sharing permission rejects missing, expired, revoked, or mismatched consent even when Bee is linked', async () => {
    for (const scenario of ['missing', 'expired', 'revoked', 'other-followup', 'other-signal', 'other-caregiver']) {
        const event = request('permission-' + scenario);
        const input = member(event);
        await grantBeeConsent(input);
        const followup = await care.createFollowup({ ...input, signal: 'tiredness', dueDate: '2030-01-10', dueTime: '18:00' });
        if (scenario !== 'missing') {
            const consent = await care.requestConsent({
                ...input, caregiverName: scenario === 'other-caregiver' ? 'Someone else' : 'Laura',
                signal: scenario === 'other-signal' ? 'sleep' : 'tiredness',
                followupId: scenario === 'other-followup' ? 'another-followup' : followup.followupId,
                ...(scenario === 'expired' ? { expiresAt: Math.floor(Date.now() / 1000) - 1 } : {})
            });
            if (scenario === 'revoked') await repository.updateRecord(consent.pk, consent.sk, { status: 'revoked' });
        }
        const { data } = await summary(event);
        assert.equal(data.dashboard.permission, 'No active permission for Laura on the next follow-up', scenario);
        assert.equal(data.caregiverAlerted, false);
    }
});

test('the latest report remains visible when the selected period has no reports', async () => {
    const event = request('older-report', 'today');
    const input = member(event);
    await care.logWellnessEvent({ ...input, signal: 'sleep', state: 'reported', numericValue: 7,
        recordedAt: new Date(Date.now() - 2 * 86400000).toISOString() });
    const { data } = await summary(event);
    assert.match(data.summaryLine, /0 reports/);
    assert.equal(data.signals.sleep.value, 'No data');
    assert.match(data.dashboard.lastReport, /^sleep on /);
    assert.equal(data.dashboard.nextFollowup, 'None scheduled');
    assert.equal(data.dashboard.permission, 'No follow-up awaiting permission');
    const voiceOnly = await handler(request('older-report', 'today', false), {});
    assert.equal(voiceOnly.response.directives?.length || 0, 0);
    assert.match(voiceOnly.response.outputSpeech.ssml, /summary/);
});

test('dashboard reuses loaded context, history and follow-up and reads only the exact consent', async () => {
    const input = { ownerId: 'reuse', memberName: 'Elena' };
    const context = await care.getCareContext(input);
    const followup = await care.createFollowup({ ...input, signal: 'sleep', dueDate: '2030-01-10', dueTime: '18:00' });
    const consent = await care.requestConsent({ ...input, caregiverName: context.caregiverName,
        signal: followup.signal, followupId: followup.followupId });
    const commands = [];
    process.env.CARE_TABLE_NAME = 'test';
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        commands.push(command);
        return { Item: consent };
    });
    const data = await care.getCareDashboard({ ...input, context, followup,
        history: [{ signal: 'sleep', recordedAt: new Date().toISOString() }] });
    assert.equal(data.permission, 'Active for Laura on this follow-up');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].constructor.name, 'GetCommand');
    assert.equal(commands[0].input.Key.sk, consent.sk);
});

test('the original dashboard renderer remains available and escapes dynamic data', () => {
    const directives = [];
    const responseBuilder = { addDirective(directive) { directives.push(directive); return this; } };
    const input = { requestEnvelope: request('legacy-dashboard'), responseBuilder };
    addCareDashboard(input, { lastReport: '<sleep>', nextFollowup: 'None scheduled', permission: 'Laura & member' });
    assert.equal(directives[0].token, 'carepulse-dashboard');
    assert.equal(directives[0].datasources.careData.lastReport, '&lt;sleep&gt;');
    assert.equal(directives[0].datasources.careData.permission, 'Laura &amp; member');
});

test('Bee retains verified legacy sleepHoursBaseline support without assuming an unverified routine', async () => {
    const input = { ownerId: 'legacy-baseline', memberName: 'Elena' };
    const context = await care.getCareContext(input);
    await repository.updateRecord(context.pk, context.sk,
        { sleepHoursBaseline: '7.5', baselineSource: 'member' }, ['baselineSleepHours']);
    assert.equal((await care.getCareContext(input)).baselineSleepHours, 7.5);
    const { linkCode } = await grantBeeConsent(input);
    await ingestBeeContext({ linkCode, beeExport: {
        exportedAt: new Date().toISOString(), healthKit: { sleepHours: 7.2 }
    } });
    const history = await care.getWellnessHistory(input);
    assert.equal(history[0].state, 'low');
    await repository.updateRecord(context.pk, context.sk, { baselineSource: 'unverified' });
    assert.equal((await care.getCareContext(input)).baselineSleepHours, null);
});

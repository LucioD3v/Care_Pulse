'use strict';

const assert = require('node:assert/strict');
const { beforeEach, afterEach, test, mock } = require('node:test');
const care = require('../care_service');
const { handler, _private } = require('../index');
const { DOCUMENT_TOKEN, suggestedFollowupTimes } = require('../report_wellness_presentation');

const BACKGROUND_URL = 'https://assets.example.test/carepulse-report-background.png';

beforeEach(() => {
    care.resetMockRecords();
    process.env.CAREPULSE_REPORT_BACKGROUND_URL = BACKGROUND_URL;
    mock.method(console, 'info', () => {});
});

afterEach(() => {
    delete process.env.CAREPULSE_REPORT_BACKGROUND_URL;
    delete process.env.DEMO_OWNER_ID;
    mock.restoreAll();
});

function reportRequest(userId, screen = true) {
    return {
        version: '1.0',
        session: { new: false, sessionId: 'report-session', application: { applicationId: 'test' },
            user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
        request: {
            type: 'IntentRequest',
            requestId: 'report-request',
            timestamp: '2030-01-10T16:00:00Z',
            locale: 'en-US',
            intent: {
                name: 'ReportWellnessIntent',
                confirmationStatus: 'NONE',
                slots: {
                    wellnessSignal: { name: 'wellnessSignal', value: 'tiredness' },
                    intensity: { name: 'intensity', value: 'more than usual' }
                }
            }
        }
    };
}

function userEvent(userId, attributes, time) {
    return {
        version: '1.0',
        session: { new: false, sessionId: 'report-session', application: { applicationId: 'test' },
            user: { userId }, attributes },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: {
            type: 'Alexa.Presentation.APL.UserEvent',
            requestId: `report-button-${time}`,
            timestamp: '2030-01-10T16:01:00Z',
            locale: 'en-US',
            token: DOCUMENT_TOKEN,
            arguments: ['schedule-report-checkin', time],
            components: {}
        }
    };
}

test('wellness report renders the branded APL card with three unique evening choices', async () => {
    const response = await handler(reportRequest('report-screen'), {});
    const directive = response.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.token, DOCUMENT_TOKEN);
    assert.equal(directive.datasources.reportData.backgroundImageUrl, BACKGROUND_URL);
    assert.match(directive.datasources.reportData.headline, /tiredness report is saved/i);
    assert.deepEqual(directive.datasources.reportData.options.map(option => option.time), ['18:00', '19:00', '20:00']);
    assert.deepEqual(directive.datasources.reportData.options.map(option => option.label), ['6 PM', '7 PM', '8 PM']);
    const rendered = JSON.stringify(directive.document);
    assert.match(rendered, /schedule-report-checkin/);
    assert.match(rendered, /SendEvent/);
});

test('voice-only wellness reports keep the existing spoken flow without an APL directive', async () => {
    const response = await handler(reportRequest('report-speaker', false), {});
    assert.equal(response.response.directives?.length || 0, 0);
    assert.match(response.response.outputSpeech.ssml, /check-in/i);
});

test('discreet mode keeps member and signal details out of the report screen', async () => {
    const userId = 'report-discreet';
    const request = reportRequest(userId);
    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    await care.getCareContext(input);
    await care.updateCarePreferences({ ...input, discreetMode: 'on' });
    const response = await handler(request, {});
    const data = response.response.directives[0].datasources.reportData;
    assert.equal(data.headline, 'Your wellness report is saved');
    assert.equal(data.summary, 'Thank you for checking in.');
    assert.doesNotMatch(JSON.stringify(data), /Elena|tiredness/i);
});

test('tapping the 7 PM button creates that follow-up and continues to scoped consent', async () => {
    const userId = 'report-button-user';
    const request = reportRequest(userId);
    const report = await handler(request, {});
    const scheduled = await handler(userEvent(userId, report.sessionAttributes, '19:00'), {});
    assert.match(scheduled.response.outputSpeech.ssml, /7 PM/i);
    assert.match(scheduled.response.outputSpeech.ssml, /authorize Laura/i);
    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    const followups = (await care.listFollowups(input)).followups;
    assert.equal(followups.length, 1);
    assert.equal(followups[0].dueTime, '19:00');
    assert.equal(scheduled.sessionAttributes.conversationState, _private.STATES.AWAITING_CONSENT_CONFIRMATION);
});

test('button choices stay unique when the preferred time is already 7 or 8 PM', () => {
    assert.deepEqual(suggestedFollowupTimes('19:00'), ['19:00', '20:00', '18:00']);
    assert.deepEqual(suggestedFollowupTimes('20:00'), ['20:00', '19:00', '18:00']);
});

test('a stale or forged APL time cannot create a follow-up', async () => {
    const userId = 'report-forged-button';
    const request = reportRequest(userId);
    const report = await handler(request, {});
    const rejected = await handler(userEvent(userId, report.sessionAttributes, '23:45'), {});
    assert.match(rejected.response.outputSpeech.ssml, /no longer available/i);
    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    assert.equal((await care.listFollowups(input)).followups.length, 0);
});

// --- Bug 3: schedule the exact offered {time, dueDate} pair on tap ---

function reportRequestAt(userId, timestamp, screen = true) {
    const request = reportRequest(userId, screen);
    request.request.timestamp = timestamp;
    return request;
}

function userEventAt(userId, attributes, time, timestamp) {
    const event = userEvent(userId, attributes, time);
    event.request.timestamp = timestamp;
    return event;
}

// Property 1: Bug Condition — Tap-Time Date Roll.
// The report is offered just before 18:00 local (Mexico City, UTC-6) so the 6 PM
// option's dueDate is "today" (2030-01-10). The tap arrives just after 18:00 local,
// after the offered minute has elapsed relative to the request timestamp. On unfixed
// code followupSchedule recomputes the date from the tap timestamp and rolls it to
// tomorrow (2030-01-11); the scheduled dueDate must stay the offered 2030-01-10.
// **Validates: Requirements 3.1, 3.2**
test('tapping an option after its minute elapsed keeps the offered dueDate (no roll to tomorrow)', async () => {
    const userId = 'report-dateroll-user';
    // 2030-01-10T23:59:00Z => Mexico City 2030-01-10 17:59 (local), one minute before 6 PM.
    const request = reportRequestAt(userId, '2030-01-10T23:59:00Z');
    const report = await handler(request, {});
    const directive = report.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    const offeredSixPm = directive.datasources.reportData.options.find(option => option.time === '18:00');
    assert.ok(offeredSixPm, 'the 6 PM option should be offered');

    // 2030-01-11T00:01:00Z => Mexico City 2030-01-10 18:01 (local), one minute after the offered 6 PM.
    const scheduled = await handler(userEventAt(userId, report.sessionAttributes, '18:00', '2030-01-11T00:01:00Z'), {});
    assert.match(scheduled.response.outputSpeech.ssml, /authorize Laura/i);

    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    const followups = (await care.listFollowups(input)).followups;
    assert.equal(followups.length, 1);
    assert.equal(followups[0].dueTime, '18:00');
    // The scheduled dueDate must equal the offered pair's dueDate, with no roll to tomorrow.
    assert.equal(followups[0].dueDate, '2030-01-10');
});

// Property 1: Bug Condition — a tapped option absent from attributes.followupOptions
// (never offered / expired) must be rejected with a safe prompt and schedule nothing.
// **Validates: Requirements 3.3**
test('tapping an option that was never offered is rejected with a safe prompt', async () => {
    const userId = 'report-unknown-option';
    const request = reportRequestAt(userId, '2030-01-10T23:59:00Z');
    const report = await handler(request, {});
    // 17:00 is a valid HH:mm but is not among the offered evening options.
    const rejected = await handler(userEventAt(userId, report.sessionAttributes, '17:00', '2030-01-11T00:01:00Z'), {});
    assert.match(rejected.response.outputSpeech.ssml, /no longer available/i);
    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    assert.equal((await care.listFollowups(input)).followups.length, 0);
});

// Property 2: Preservation — a tap on a still-valid offered option (the minute has NOT
// elapsed) follows the same consent flow/copy and schedules the offered date as before.
// **Validates: Requirements 3.2**
test('tapping a still-valid offered option follows the existing consent flow and date', async () => {
    const userId = 'report-valid-tap-user';
    const request = reportRequestAt(userId, '2030-01-10T16:00:00Z');
    const report = await handler(request, {});
    const scheduled = await handler(userEventAt(userId, report.sessionAttributes, '19:00', '2030-01-10T16:01:00Z'), {});
    assert.match(scheduled.response.outputSpeech.ssml, /7 PM/i);
    assert.match(scheduled.response.outputSpeech.ssml, /authorize Laura/i);
    assert.equal(scheduled.sessionAttributes.conversationState, _private.STATES.AWAITING_CONSENT_CONFIRMATION);
    const input = { ownerId: _private.ownerId({ requestEnvelope: request }), memberName: 'Elena' };
    const followups = (await care.listFollowups(input)).followups;
    assert.equal(followups.length, 1);
    assert.equal(followups[0].dueTime, '19:00');
    assert.equal(followups[0].dueDate, '2030-01-10');
});

// Property 2: Preservation — voice ScheduleFollowupIntent path is unchanged.
// **Validates: Requirements 3.4**
test('voice ScheduleFollowupIntent schedules with the existing flow and copy', async () => {
    const userId = 'report-voice-schedule-user';
    // Seed a report so the member/context exist, then schedule via the voice intent.
    const report = await handler(reportRequestAt(userId, '2030-01-10T16:00:00Z'), {});
    const scheduleIntent = {
        version: '1.0',
        session: { new: false, sessionId: 'report-session', application: { applicationId: 'test' },
            user: { userId }, attributes: report.sessionAttributes },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'speaker', supportedInterfaces: {} } } },
        request: {
            type: 'IntentRequest',
            requestId: 'voice-schedule-request',
            timestamp: '2030-01-10T16:02:00Z',
            locale: 'en-US',
            intent: {
                name: 'ScheduleFollowupIntent',
                confirmationStatus: 'NONE',
                slots: { followupTime: { name: 'followupTime', value: '20:00' } }
            }
        }
    };
    const scheduled = await handler(scheduleIntent, {});
    assert.match(scheduled.response.outputSpeech.ssml, /authorize Laura/i);
    assert.equal(scheduled.sessionAttributes.conversationState, _private.STATES.AWAITING_CONSENT_CONFIRMATION);
    const input = { ownerId: _private.ownerId({ requestEnvelope: scheduleIntent }), memberName: 'Elena' };
    const followups = (await care.listFollowups(input)).followups;
    assert.equal(followups.length, 1);
    assert.equal(followups[0].dueTime, '20:00');
    assert.equal(followups[0].dueDate, '2030-01-10');
});

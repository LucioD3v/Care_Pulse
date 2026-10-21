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

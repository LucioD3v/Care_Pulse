'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, test, mock } = require('node:test');
const care = require('../care_service');
const { handler } = require('../index');
const { DOCUMENT_TOKEN } = require('../welcome_presentation');
const { COPY } = require('../voice_copy');

const OWNER_ID = 'welcome-menu-owner';

beforeEach(() => {
    care.resetMockRecords();
    process.env.CARE_MODE = 'demo';
    process.env.CARE_STORAGE_MODE = 'memory';
    process.env.DEMO_OWNER_ID = OWNER_ID;
    process.env.CAREPULSE_COVER_IMAGE_URL = 'https://assets.example.test/cover.png';
    process.env.CAREPULSE_HOME_BACKGROUND_URL = 'https://assets.example.test/home.png';
    mock.method(console, 'info', () => {});
});

afterEach(() => {
    for (const name of ['CARE_MODE', 'CARE_STORAGE_MODE', 'DEMO_OWNER_ID', 'CAREPULSE_COVER_IMAGE_URL',
        'CAREPULSE_HOME_BACKGROUND_URL']) delete process.env[name];
    mock.restoreAll();
});

function launchRequest(userId = 'welcome-menu-user') {
    return {
        version: '1.0',
        session: { new: true, sessionId: 'welcome-menu-session', application: { applicationId: 'test' },
            user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: { type: 'LaunchRequest', requestId: 'welcome-menu-launch',
            timestamp: '2030-01-10T23:00:00Z', locale: 'en-US' }
    };
}

function voiceSummaryRequest(intentName, userId = 'welcome-menu-user') {
    return {
        version: '1.0',
        session: { new: false, sessionId: 'welcome-menu-session', application: { applicationId: 'test' },
            user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: {
            type: 'IntentRequest', requestId: `voice-${intentName}`,
            timestamp: '2030-01-10T23:00:05Z', locale: 'en-US',
            intent: { name: intentName, confirmationStatus: 'NONE', slots: {} }
        }
    };
}

function userEvent(attributes, action, userId = 'welcome-menu-user') {
    return {
        version: '1.0',
        session: { new: false, sessionId: 'welcome-menu-session', application: { applicationId: 'test' },
            user: { userId }, attributes },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: {
            type: 'Alexa.Presentation.APL.UserEvent', requestId: `welcome-${action}`,
            timestamp: '2030-01-10T23:00:05Z', locale: 'en-US', token: DOCUMENT_TOKEN,
            arguments: ['welcome-action', action], components: {}
        }
    };
}

test('normal launch transitions after five seconds to the actionable home menu', async () => {
    const response = await handler(launchRequest(), {});
    const directive = response.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.token, DOCUMENT_TOKEN);
    assert.equal(directive.datasources.coverData.backgroundImageUrl, 'https://assets.example.test/home.png');
    assert.equal(response.sessionAttributes.conversationState, 'WELCOME_MENU');
    assert.equal(directive.document.mainTemplate.items[0].onMount[0].delay, 5000);
});

test('report button starts the existing wellness-report conversation', async () => {
    const launch = await handler(launchRequest(), {});
    const response = await handler(userEvent(launch.sessionAttributes, 'report'), {});
    assert.match(response.response.outputSpeech.ssml, /Tell me how you feel/i);
    assert.match(response.response.reprompt.outputSpeech.ssml, /I feel more tired than usual/i);
    assert.equal(response.response.shouldEndSession, false);
    assert.equal(response.response.directives, undefined);
    assert.equal(response.sessionAttributes.conversationState, 'AWAITING_WELLNESS_REPORT');
});

test('summary button runs the existing wellness summary action', async () => {
    const launch = await handler(launchRequest(), {});
    const response = await handler(userEvent(launch.sessionAttributes, 'summary'), {});
    const ssml = response.response.outputSpeech.ssml;
    // Property 1 (bug condition): the weak /summary/i match is satisfied by COPY.error
    // too ("Please check your summary..."). Assert real summary content is present and
    // that the error copy is NOT returned.
    assert.match(ssml, /wellness reports across/i);
    assert.doesNotMatch(ssml, /could not confirm the result/i);
    assert.ok(!ssml.includes(COPY.error), 'summary button must not return COPY.error');
});

test('voice GetWellnessSummaryIntent (short) returns a wellness summary', async () => {
    const response = await handler(voiceSummaryRequest('GetWellnessSummaryIntent'), {});
    const ssml = response.response.outputSpeech.ssml;
    assert.match(ssml, /wellness reports across/i);
    assert.doesNotMatch(ssml, /could not confirm the result/i);
    // short copy prompts to ask for details; detailed copy adds the diagnosis note.
    assert.match(ssml, /Ask for details if you want the signals/i);
});

test('voice GetWellnessDetailsIntent (detailed) returns the detailed summary', async () => {
    const response = await handler(voiceSummaryRequest('GetWellnessDetailsIntent'), {});
    const ssml = response.response.outputSpeech.ssml;
    assert.match(ssml, /wellness reports across/i);
    assert.doesNotMatch(ssml, /could not confirm the result/i);
    assert.match(ssml, /covering/i);
});

test('schedule button creates the default check-in and continues to consent', async () => {
    const launch = await handler(launchRequest(), {});
    const response = await handler(userEvent(launch.sessionAttributes, 'schedule'), {});
    assert.match(response.response.outputSpeech.ssml, /check-in is saved/i);
    assert.match(response.response.outputSpeech.ssml, /authorize Laura/i);
    const followups = (await care.listFollowups({ ownerId: OWNER_ID, memberName: 'Elena' })).followups;
    assert.equal(followups.length, 1);
    assert.equal(followups[0].signal, 'tiredness');
});

test('stale or forged home-menu actions are rejected', async () => {
    const launch = await handler(launchRequest(), {});
    const response = await handler(userEvent(launch.sessionAttributes, 'delete-everything'), {});
    assert.match(response.response.outputSpeech.ssml, /no longer available/i);
});

'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, test, mock } = require('node:test');
const care = require('../care_service');
const { handler } = require('../index');
const {
    DOCUMENT_TOKEN,
    permissionDirective
} = require('../permission_presentation');

const OWNER_ID = 'permission-apl-owner';
const BACKGROUND_URL = 'https://assets.example.test/carepulse-permission-background.png';

beforeEach(() => {
    care.resetMockRecords();
    process.env.CARE_MODE = 'demo';
    process.env.CARE_STORAGE_MODE = 'memory';
    process.env.DEMO_OWNER_ID = OWNER_ID;
    process.env.CAREPULSE_PERMISSION_BACKGROUND_URL = BACKGROUND_URL;
    mock.method(console, 'info', () => {});
});

afterEach(() => {
    for (const name of ['CARE_MODE', 'CARE_STORAGE_MODE', 'DEMO_OWNER_ID',
        'CAREPULSE_PERMISSION_BACKGROUND_URL']) delete process.env[name];
    mock.restoreAll();
});

function intentRequest(intentName, slots = {}, attributes = {}, screen = true) {
    const userId = 'permission-apl-user';
    return {
        version: '1.0',
        session: { new: false, sessionId: 'permission-session', application: { applicationId: 'test' },
            user: { userId }, attributes },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
        request: {
            type: 'IntentRequest', requestId: `permission-${intentName}`,
            timestamp: '2030-01-10T16:00:00Z', locale: 'en-US', dialogState: 'COMPLETED',
            intent: { name: intentName, confirmationStatus: 'NONE', slots }
        }
    };
}

test('accepting follow-up permission renders the compact branded confirmation', async () => {
    const scheduled = await handler(intentRequest('ScheduleFollowupIntent', {
        wellnessSignal: { name: 'wellnessSignal', value: 'tiredness' },
        followupTime: { name: 'followupTime', value: '18:00' }
    }), {});
    assert.equal(scheduled.sessionAttributes.conversationState, 'AWAITING_CONSENT_CONFIRMATION');

    const accepted = await handler(intentRequest('AMAZON.YesIntent', {}, scheduled.sessionAttributes), {});
    const directive = accepted.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.token, DOCUMENT_TOKEN);
    assert.equal(directive.datasources.permissionData.backgroundImageUrl, BACKGROUND_URL);
    assert.equal(directive.datasources.permissionData.caregiverName, 'Laura');
    assert.equal(directive.datasources.permissionData.condition, 'tiredness repeats');
    assert.equal(directive.datasources.permissionData.showDetails, true);
    const rendered = JSON.stringify(directive.document);
    assert.match(rendered, /Permission saved/);
    assert.match(rendered, /'28dp' : '40dp'/);
    assert.doesNotMatch(rendered, /60dp|70dp|80dp/);
});

test('discreet permission confirmation omits caregiver and signal details', () => {
    const data = permissionDirective({
        caregiverName: 'Laura', signal: 'tiredness', discreetMode: 'on'
    }).datasources.permissionData;
    assert.equal(data.showDetails, false);
    assert.equal(data.caregiverName, '');
    assert.equal(data.condition, '');
    assert.doesNotMatch(JSON.stringify(data), /Laura|tiredness/i);
});

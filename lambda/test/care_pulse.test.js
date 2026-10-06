'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const { handler } = require('../index');
const { handler: mcpHttpHandler } = require('../mcp_http');
const mcp = require('../mcp_client');
const { renderVoiceObservation } = require('../voice_agent');

beforeEach(() => {
    delete process.env.CARE_TABLE_NAME;
    delete process.env.SNS_TOPIC_ARN;
    delete process.env.DEMO_OWNER_ID;
    delete process.env.MCP_API_KEY;
    delete process.env.BEDROCK_MODEL_ID;
    delete process.env.REQUIRE_BEDROCK;
    mcp.resetMockRecords();
});

function alexaRequest({ intentName, slots = {}, attributes = {}, userId = 'test-user', type = 'IntentRequest' }) {
    const request = type === 'LaunchRequest'
        ? { type, requestId: `request-${Date.now()}`, timestamp: new Date().toISOString(), locale: 'en-US' }
        : {
            type,
            requestId: `request-${Date.now()}`,
            timestamp: new Date().toISOString(),
            locale: 'en-US',
            intent: { name: intentName, confirmationStatus: 'NONE', slots }
        };
    return {
        version: '1.0',
        session: {
            new: false,
            sessionId: 'test-session',
            application: { applicationId: 'test' },
            user: { userId },
            attributes
        },
        context: {
            System: {
                application: { applicationId: 'test' },
                user: { userId },
                device: { deviceId: 'test-device', supportedInterfaces: {} }
            }
        },
        request
    };
}

function slot(name, value) {
    return { name, value };
}

function invokeAlexa(event) {
    return new Promise((resolve, reject) => {
        handler(event, {}, (error, response) => error ? reject(error) : resolve(response));
    });
}

test('interaction model exposes the MVP intents and required slots', () => {
    const modelPath = path.join(__dirname, '..', '..', 'skill-package', 'interactionModels', 'custom', 'en-US.json');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')).interactionModel.languageModel;
    const intents = new Map(model.intents.map(intent => [intent.name, intent]));
    assert.deepEqual(intents.get('ReportWellnessIntent').slots.map(item => item.name), [
        'memberName', 'wellnessSignal', 'intensity', 'sleepHours'
    ]);
    assert.ok(intents.has('ScheduleFollowupIntent'));
    assert.ok(intents.has('ConfigureCaregiverAlertIntent'));
    assert.ok(intents.has('CompleteFollowupIntent'));
    assert.ok(intents.has('GetWellnessSummaryIntent'));
    assert.ok(intents.has('EmergencyGuidanceIntent'));
    assert.ok(intents.has('AMAZON.YesIntent'));
    assert.ok(intents.has('AMAZON.NoIntent'));
});

test('MCP surface matches the CarePulse strategy', () => {
    assert.deepEqual(mcp.MCP_TOOLS.map(tool => tool.name), [
        'get_care_context',
        'log_wellness_event',
        'get_wellness_history',
        'compare_with_baseline',
        'create_followup',
        'request_consent',
        'send_caregiver_alert'
    ]);
});

test('deployed runtime refuses to continue without the required Bedrock model', async () => {
    process.env.REQUIRE_BEDROCK = 'true';
    await assert.rejects(
        () => renderVoiceObservation({
            memberName: 'Elena',
            signal: 'tiredness',
            comparison: { changeObserved: false, summary: 'No change observed.' }
        }),
        /BEDROCK_MODEL_ID is required/
    );
});

test('MCP 2025-11-25 HTTP flow initializes a session and lists native tools', async () => {
    process.env.MCP_API_KEY = 'test-mcp-key';
    const initialize = await mcpHttpHandler({
        headers: { 'x-carepulse-mcp-key': 'test-mcp-key' },
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'test-client', version: '1.0.0' }
            }
        })
    });
    assert.equal(initialize.statusCode, 200);
    const sessionId = initialize.headers['mcp-session-id'];
    assert.ok(sessionId);
    assert.equal(JSON.parse(initialize.body).result.protocolVersion, '2025-11-25');

    const tools = await mcpHttpHandler({
        headers: {
            'x-carepulse-mcp-key': 'test-mcp-key',
            'mcp-session-id': sessionId
        },
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    const toolNames = JSON.parse(tools.body).result.tools.map(tool => tool.name);
    assert.deepEqual(toolNames, mcp.MCP_TOOLS.map(tool => tool.name));
});

test('baseline comparison observes repeated signals without diagnosing', async () => {
    const input = { ownerId: 'owner-a', memberName: 'Elena', signal: 'tiredness', state: 'more than usual' };
    await mcp.logWellnessEvent(input);
    await mcp.logWellnessEvent(input);
    const comparison = await mcp.compareWithBaseline(input);
    assert.equal(comparison.changeObserved, true);
    assert.equal(comparison.repeatedCount, 2);
    assert.match(comparison.summary, /not a diagnosis/);
});

test('an alert is blocked when scoped consent is absent', async () => {
    const decision = await mcp.evaluateAlertPolicy({
        ownerId: 'owner-b',
        memberName: 'Elena',
        caregiverName: 'Laura',
        signal: 'tiredness',
        followupId: 'followup-without-consent',
        followupStatus: 'same'
    });
    assert.deepEqual(decision, { allowed: false, reason: 'consent_missing_or_expired' });
    await assert.rejects(
        () => mcp.sendCaregiverAlert({ memberName: 'Elena', authorized: false }),
        /requires an allowed policy decision/
    );
});

test('happy path records wellness, schedules follow-up, stores consent, and prepares the authorized alert', async () => {
    const userId = `happy-${Date.now()}`;
    const report = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'ReportWellnessIntent',
        slots: {
            wellnessSignal: slot('wellnessSignal', 'tiredness'),
            intensity: slot('intensity', 'more than usual')
        }
    }));
    assert.match(report.response.outputSpeech.ssml, /check in again at six/i);

    const schedule = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'AMAZON.YesIntent',
        attributes: report.sessionAttributes
    }));
    assert.match(schedule.response.outputSpeech.ssml, /authorize Laura/i);

    const consent = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'AMAZON.YesIntent',
        attributes: schedule.sessionAttributes
    }));
    assert.match(consent.response.outputSpeech.ssml, /permission applies only to this follow-up/i);

    const completed = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'CompleteFollowupIntent',
        slots: { followupStatus: slot('followupStatus', 'same') }
    }));
    assert.match(completed.response.outputSpeech.ssml, /authorized alert was prepared/i);
    assert.match(completed.response.card.content, /Notification simulated/);
});

test('declining consent leaves the follow-up in place but prevents sharing', async () => {
    const userId = `decline-${Date.now()}`;
    const schedule = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'ScheduleFollowupIntent',
        slots: { followupTime: slot('followupTime', '18:00') }
    }));
    const declined = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'AMAZON.NoIntent',
        attributes: schedule.sessionAttributes
    }));
    assert.match(declined.response.outputSpeech.ssml, /will not share it with anyone/i);

    const completed = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'CompleteFollowupIntent',
        slots: { followupStatus: slot('followupStatus', 'same') }
    }));
    assert.match(completed.response.outputSpeech.ssml, /did not share it because there is no active permission/i);
});

test('emergency language never presents CarePulse as emergency assistance', async () => {
    const response = await invokeAlexa(alexaRequest({ intentName: 'EmergencyGuidanceIntent' }));
    assert.match(response.response.outputSpeech.ssml, /cannot handle emergencies/i);
    assert.match(response.response.outputSpeech.ssml, /local emergency number/i);
});

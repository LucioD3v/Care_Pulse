'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { handler } = require('../index');
const mcp = require('../mcp_client');

function withEnvironment(name, value, callback) {
    const original = process.env[name];
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            if (original === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = original;
            }
        });
}

function alexaIntent(intentName, slots) {
    return {
        version: '1.0',
        session: { new: true, sessionId: 'test-session', application: { applicationId: 'test' }, user: { userId: 'test-user' } },
        context: { System: { application: { applicationId: 'test' }, user: { userId: 'test-user' }, device: { deviceId: 'test-device', supportedInterfaces: {} } } },
        request: {
            type: 'IntentRequest',
            requestId: 'test-request',
            timestamp: new Date().toISOString(),
            locale: 'en-US',
            intent: { name: intentName, confirmationStatus: 'NONE', slots }
        }
    };
}

function invokeAlexa(event) {
    return new Promise((resolve, reject) => {
        handler(event, {}, (error, response) => error ? reject(error) : resolve(response));
    });
}

test('interaction model exposes requested intents and slots', () => {
    const modelPath = path.join(__dirname, '..', '..', 'skill-package', 'interactionModels', 'custom', 'en-US.json');
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')).interactionModel.languageModel;
    const intents = new Map(model.intents.map(intent => [intent.name, intent]));
    assert.deepEqual(intents.get('LogVitalIntent').slots.map(slot => slot.name), ['vitalType', 'value', 'memberName']);
    assert.deepEqual(intents.get('CheckTrendsIntent').slots.map(slot => slot.name), ['memberName', 'timeframe']);
    assert.deepEqual(intents.get('TriggerAlertIntent').slots.map(slot => slot.name), ['memberName']);
});

test('MCP tools record and retrieve mock health history', async () => {
    assert.deepEqual(mcp.MCP_TOOLS.map(tool => tool.name), [
        'log_health_metric', 'get_health_history', 'analyze_health_trends', 'trigger_caregiver_alert'
    ]);
    const memberName = `Test-${Date.now()}`;
    const logged = await mcp.logHealthMetric({
        type: 'temperature',
        value: 38.8,
        unit: 'degrees Celsius',
        date: new Date().toISOString(),
        memberName
    });
    assert.equal(logged.source, 'mock');
    const history = await mcp.getHealthHistory({ memberName, timeframe: 'today' });
    assert.equal(history.length, 1);
    assert.match((await mcp.analyzeHealthTrends({ memberName, history }))[0], /one temperature reading/);
});

test('SNS mock never reports a notification as delivered', async () => {
    await withEnvironment('SNS_TOPIC_ARN', undefined, async () => {
        const result = await mcp.triggerCaregiverAlert({ memberName: 'Test member', message: 'Check-in requested.' });
        assert.equal(result.sent, false);
        assert.equal(result.simulated, true);
    });
});

test('Alexa records a high fever and clearly reports unavailable alert delivery', async () => {
    await withEnvironment('SNS_TOPIC_ARN', undefined, () => withEnvironment('BEDROCK_MODEL_ID', undefined, async () => {
        const response = await invokeAlexa(alexaIntent('LogVitalIntent', {
            vitalType: { name: 'vitalType', value: 'temperature' },
            value: { name: 'value', value: '38 point 8' },
            memberName: { name: 'memberName', value: 'Lia' }
        }));
        assert.match(response.response.outputSpeech.ssml, /could not send the caregiver alert/);
        assert.match(response.response.outputSpeech.ssml, /38\.8/);
    }));
});

test('Fahrenheit readings are not mistaken for Celsius fever', async () => {
    await withEnvironment('SNS_TOPIC_ARN', undefined, () => withEnvironment('BEDROCK_MODEL_ID', undefined, async () => {
        const response = await invokeAlexa(alexaIntent('LogVitalIntent', {
            vitalType: { name: 'vitalType', value: 'temperature' },
            value: { name: 'value', value: '100 degrees Fahrenheit' },
            memberName: { name: 'memberName', value: 'Lia' }
        }));
        assert.doesNotMatch(response.response.outputSpeech.ssml, /could not send the caregiver alert/);
        assert.match(response.response.outputSpeech.ssml, /degrees Fahrenheit/);
    }));
});
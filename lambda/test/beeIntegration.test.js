'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const {
    buildSignalEntry,
    sleepIntensity,
    signalsFromHistory,
    buildWellnessSnapshotPayload,
    wellnessSnapshotDirective
} = require('../apl/wellnessSnapshotPayload');
const { ingestBeeContext, extractSignalsFromText } = require('../tools/ingestBeeContext');
const { handler } = require('../index');
const { handler: mcpHttpHandler } = require('../mcp_http');
const mcp = require('../care_service');

beforeEach(() => {
    delete process.env.CARE_TABLE_NAME;
    delete process.env.DEMO_OWNER_ID;
    delete process.env.MCP_API_KEY;
    mcp.resetMockRecords();
});

const BEE_EXPORT = {
    exportedAt: new Date().toISOString(),
    facts: [{ content: 'Elena said she felt completely exhausted after lunch' }],
    conversations: [{ summary: 'She mentioned being very anxious about the appointment' }],
    healthKit: { sleepHours: 5 }
};

function alexaRequest({ userId, intentName, supportedInterfaces = {} }) {
    return {
        version: '1.0',
        session: { new: false, sessionId: 's', application: { applicationId: 'test' }, user: { userId }, attributes: {} },
        context: {
            System: {
                application: { applicationId: 'test' },
                user: { userId },
                device: { deviceId: 'd', supportedInterfaces }
            }
        },
        request: {
            type: 'IntentRequest',
            requestId: `r-${Date.now()}`,
            timestamp: new Date().toISOString(),
            locale: 'en-US',
            intent: { name: intentName, confirmationStatus: 'NONE', slots: {} }
        }
    };
}

function invokeAlexa(event) {
    return new Promise((resolve, reject) => {
        handler(event, {}, (error, response) => error ? reject(error) : resolve(response));
    });
}

function ownerIdFor(event) {
    return require('../index')._private.ownerId({ requestEnvelope: event });
}

// --- sleepIntensity ---

test('sleepIntensity returns low for delta <= 0.5h', () => {
    assert.equal(sleepIntensity(8, 8), 'low');
    assert.equal(sleepIntensity(7.5, 8), 'low');
});

test('sleepIntensity returns moderate for 0.5 < delta <= 2h', () => {
    assert.equal(sleepIntensity(7, 8), 'moderate');
    assert.equal(sleepIntensity(6, 8), 'moderate');
});

test('sleepIntensity returns high for delta > 2h', () => {
    assert.equal(sleepIntensity(5, 8), 'high');
    assert.equal(sleepIntensity(11, 8), 'high');
});

// --- buildSignalEntry ---

test('buildSignalEntry maps source bee to Bee 🐝 and alexa to empty', () => {
    assert.equal(buildSignalEntry('sleep', '6 h', 'low', 'bee').source, 'Bee 🐝');
    assert.equal(buildSignalEntry('mood', 'ok', 'low', 'alexa').source, '');
});

test('buildSignalEntry maps intensity to brand colors and bar width', () => {
    assert.deepEqual(
        ['low', 'moderate', 'high'].map(level => buildSignalEntry('x', 'v', level, '').statusColor),
        ['#1DB954', '#F5A623', '#E74C3C']
    );
    assert.ok(buildSignalEntry('x', 'v', 'high', '').intensityPercent > buildSignalEntry('x', 'v', 'low', '').intensityPercent);
});

// --- buildWellnessSnapshotPayload ---

test('buildWellnessSnapshotPayload carries hasBeeData and source tags', () => {
    const payload = buildWellnessSnapshotPayload({
        hasBeeData: true,
        signals: { sleep: buildSignalEntry('sleep', '6 h', 'low', 'bee'), mood: buildSignalEntry('mood', 'ok', 'low', 'alexa') }
    });
    assert.equal(payload.hasBeeData, true);
    assert.equal(payload.signals.sleep.source, 'Bee 🐝');
    assert.equal(payload.signals.mood.source, '');
});

test('buildWellnessSnapshotPayload falls back to No data for missing signals', () => {
    const payload = buildWellnessSnapshotPayload({ signals: {} });
    for (const name of ['sleep', 'energy', 'mood', 'appetite']) {
        assert.equal(payload.signals[name].value, 'No data');
    }
});

test('wellnessSnapshotDirective is a RenderDocument using the packaged template', () => {
    const directive = wellnessSnapshotDirective({ memberName: 'Elena' });
    assert.equal(directive.type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(directive.document.version, '2024.3');
    assert.ok(directive.document.layouts.SignalRow);
    assert.ok(directive.document.layouts.BeeSourceBadge);
    assert.equal(directive.datasources.wellnessData.memberName, 'Elena');
});

test('packaged APL template matches the skill-package copy', () => {
    const packaged = fs.readFileSync(path.join(__dirname, '..', 'apl', 'wellnessSnapshot.json'), 'utf8');
    const skillCopy = fs.readFileSync(path.join(__dirname, '..', '..', 'skill-package', 'assets', 'documents', 'wellnessSnapshot.json'), 'utf8');
    assert.deepEqual(JSON.parse(packaged), JSON.parse(skillCopy));
});

test('signalsFromHistory maps tiredness to energy and keeps the latest reading', () => {
    const signals = signalsFromHistory([
        { signal: 'tiredness', state: 'high', provenance: 'bee' },
        { signal: 'tiredness', state: 'low', provenance: 'voice' },
        { signal: 'sleep', state: 'moderate', numericValue: 6, provenance: 'voice' }
    ]);
    assert.equal(signals.energy.value, 'high');
    assert.equal(signals.energy.source, 'Bee 🐝');
    assert.equal(signals.sleep.value, '6 h');
    assert.equal(signals.sleep.statusColor, '#F5A623');
    assert.equal(signals.mood, undefined);
});

// --- extractSignalsFromText ---

test('extractSignalsFromText detects each supported signal', () => {
    const signals = extractSignalsFromText([
        'I feel drained', 'I slept badly', 'I am stressed', 'I am not hungry', 'I felt dizzy', 'my back aches'
    ]).map(item => item.signal);
    assert.deepEqual(signals, ['tiredness', 'sleep', 'mood', 'appetite', 'dizziness', 'discomfort']);
});

test('extractSignalsFromText does not produce duplicate signals', () => {
    const signals = extractSignalsFromText(['I am tired', 'I feel exhausted and drained']);
    assert.equal(signals.filter(item => item.signal === 'tiredness').length, 1);
});

test('extractSignalsFromText returns empty array when nothing matches', () => {
    assert.deepEqual(extractSignalsFromText(['I had a great day and went painting']), []);
});

test('extractSignalsFromText derives intensity from keywords', () => {
    const intensity = text => extractSignalsFromText([text])[0].intensity;
    assert.equal(intensity('I am completely exhausted'), 'high');
    assert.equal(intensity('I feel very tired'), 'moderate');
    assert.equal(intensity('I am tired'), 'low');
});

// --- ingestBeeContext end to end ---

test('ingestBeeContext persists Bee signals and sleep compared with the member baseline', async () => {
    const result = await ingestBeeContext({ ownerId: 'bee-owner', memberName: 'Elena', beeExport: BEE_EXPORT });
    assert.deepEqual(result, {
        success: true,
        eventsIngested: 3,
        signalsDetected: ['tiredness', 'mood', 'sleep'],
        skipped: 0,
        errors: []
    });

    const history = await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.equal(history.length, 3);
    assert.ok(history.every(event => event.provenance === 'bee' && event.source === 'bee'));
    const sleep = history.find(event => event.signal === 'sleep');
    assert.equal(sleep.numericValue, 5);
    assert.equal(sleep.state, 'high'); // default baseline 7.5h, delta 2.5h
    assert.equal(history.find(event => event.signal === 'tiredness').state, 'high');
    assert.equal(history.find(event => event.signal === 'mood').state, 'moderate');

    const ninetyDays = 90 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(history.every(event => Math.abs(event.expiresAt - (now + ninetyDays)) < 60));
});

test('re-ingesting the same Bee export is idempotent', async () => {
    await ingestBeeContext({ ownerId: 'bee-owner', memberName: 'Elena', beeExport: BEE_EXPORT });
    const again = await ingestBeeContext({ ownerId: 'bee-owner', memberName: 'Elena', beeExport: BEE_EXPORT });
    assert.equal(again.eventsIngested, 0);
    assert.equal(again.skipped, 3);
    const history = await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.equal(history.length, 3);
});

test('ingestBeeContext uses the stored sleep baseline', async () => {
    await mcp.getCareContext({ ownerId: 'baseline-owner', memberName: 'Elena' });
    const result = await ingestBeeContext({
        ownerId: 'baseline-owner',
        memberName: 'Elena',
        beeExport: { exportedAt: new Date().toISOString(), healthKit: { sleepHours: 7.2 } }
    });
    assert.equal(result.eventsIngested, 1);
    const [sleep] = await mcp.getWellnessHistory({ ownerId: 'baseline-owner', memberName: 'Elena' });
    assert.equal(sleep.state, 'low'); // baseline 7.5h, delta 0.3h
});

test('ingestBeeContext rejects exports without a valid exportedAt or sleep value', async () => {
    await assert.rejects(
        () => ingestBeeContext({ ownerId: 'o', memberName: 'Elena', beeExport: { facts: [] } }),
        /exportedAt/
    );
    await assert.rejects(
        () => ingestBeeContext({ ownerId: 'o', memberName: 'Elena', beeExport: { exportedAt: new Date().toISOString(), healthKit: { sleepHours: 30 } } }),
        /sleepHours/
    );
});

test('MCP gateway lists and executes ingest_bee_context', async () => {
    process.env.MCP_API_KEY = 'test-mcp-key';
    const call = async (sessionId, body) => mcpHttpHandler({
        headers: { 'x-carepulse-mcp-key': 'test-mcp-key', ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({ jsonrpc: '2.0', ...body })
    });
    const init = await call(null, {
        id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    });
    const sessionId = init.headers['mcp-session-id'];

    const list = JSON.parse((await call(sessionId, { id: 2, method: 'tools/list', params: {} })).body);
    const tool = list.result.tools.find(item => item.name === 'ingest_bee_context');
    assert.deepEqual(tool.inputSchema.required, ['ownerId', 'memberName', 'beeExport']);

    const response = JSON.parse((await call(sessionId, {
        id: 3,
        method: 'tools/call',
        params: { name: 'ingest_bee_context', arguments: { ownerId: 'mcp-owner', memberName: 'Elena', beeExport: BEE_EXPORT } }
    })).body);
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.eventsIngested, 3);
    assert.equal(JSON.parse(response.result.content[0].text).success, true);
});

// --- Alexa summary with the Wellness Snapshot card ---

test('wellness summary renders Bee data on the APL card and stays voice-only without a screen', async () => {
    const userId = `bee-screen-${Date.now()}`;
    const screenRequest = alexaRequest({
        userId,
        intentName: 'GetWellnessSummaryIntent',
        supportedInterfaces: { 'Alexa.Presentation.APL': {} }
    });
    await ingestBeeContext({ ownerId: ownerIdFor(screenRequest), memberName: 'Elena', beeExport: BEE_EXPORT });

    const screen = await invokeAlexa(screenRequest);
    const directive = screen.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    const data = directive.datasources.wellnessData;
    assert.equal(data.hasBeeData, true);
    assert.equal(data.memberName, 'Elena');
    assert.equal(data.signals.sleep.value, '5 h');
    assert.equal(data.signals.sleep.statusColor, '#E74C3C');
    assert.equal(data.signals.sleep.source, 'Bee 🐝');
    assert.equal(data.signals.energy.source, 'Bee 🐝');
    assert.equal(data.signals.mood.statusColor, '#F5A623');
    assert.equal(data.signals.appetite.value, 'No data');
    assert.match(screen.response.outputSpeech.ssml, /3 wellness reports/);

    const voiceOnly = await invokeAlexa(alexaRequest({ userId, intentName: 'GetWellnessSummaryIntent' }));
    assert.equal(voiceOnly.response.directives?.length || 0, 0);
    assert.match(voiceOnly.response.outputSpeech.ssml, /summary/);
});

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { beforeEach, test } = require('node:test');
const {
    buildSignalEntry,
    sleepIntensity,
    signalsFromHistory,
    buildWellnessSnapshotPayload,
    wellnessSnapshotDirective
} = require('../apl/wellnessSnapshotPayload');
const { ingestBeeContext, extractSignalsFromText, selectWearerTexts } = require('../tools/ingestBeeContext');
const { grantBeeConsent, revokeBeeConsent, resolveBeeLink } = require('../bee_link');
const { handler } = require('../index');
const { handler: mcpHttpHandler } = require('../mcp_http');
const mcp = require('../care_service');

beforeEach(() => {
    delete process.env.CARE_TABLE_NAME;
    delete process.env.DEMO_OWNER_ID;
    delete process.env.MCP_API_KEY;
    delete process.env.BEE_CONSENT_DAYS;
    mcp.resetMockRecords();
});

const BEE_EXPORT = {
    exportedAt: new Date().toISOString(),
    facts: [
        { text: 'Elena felt completely exhausted after lunch', confirmed: true },
        { text: 'Elena has no appetite in the mornings', confirmed: false }
    ],
    conversations: [{
        utterances: [
            { speaker: 'wearer', text: 'I am very anxious about the appointment' },
            { speaker: 'other', text: 'I feel dizzy and in pain' }
        ]
    }],
    healthKit: { sleepHours: 5 }
};

function alexaRequest({ userId, intentName, attributes = {}, supportedInterfaces = {} }) {
    return {
        version: '1.0',
        session: { new: false, sessionId: 's', application: { applicationId: 'test' }, user: { userId }, attributes },
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

async function linkedCode(ownerId = 'bee-owner', memberName = 'Elena') {
    return (await grantBeeConsent({ ownerId, memberName })).linkCode;
}

// --- APL payload ---

test('sleepIntensity classifies the delta from baseline', () => {
    assert.equal(sleepIntensity(7.5, 8), 'low');
    assert.equal(sleepIntensity(6, 8), 'moderate');
    assert.equal(sleepIntensity(5, 8), 'high');
    assert.equal(sleepIntensity(11, 8), 'high');
});

test('buildSignalEntry maps source tags and intensity colors', () => {
    assert.equal(buildSignalEntry('sleep', '6 h', 'low', 'bee').source, 'Bee 🐝');
    assert.equal(buildSignalEntry('mood', 'ok', 'low', 'alexa').source, '');
    assert.deepEqual(
        ['low', 'moderate', 'high'].map(level => buildSignalEntry('x', 'v', level, '').statusColor),
        ['#1DB954', '#F5A623', '#E74C3C']
    );
});

test('buildWellnessSnapshotPayload carries hasBeeData and falls back to No data', () => {
    const payload = buildWellnessSnapshotPayload({
        hasBeeData: true,
        signals: { sleep: buildSignalEntry('sleep', '6 h', 'low', 'bee') }
    });
    assert.equal(payload.hasBeeData, true);
    assert.equal(payload.signals.sleep.source, 'Bee 🐝');
    for (const name of ['energy', 'mood', 'appetite']) {
        assert.equal(payload.signals[name].value, 'No data');
    }
});

test('wellnessSnapshotDirective uses the packaged template, identical to the skill-package copy', () => {
    const directive = wellnessSnapshotDirective({ memberName: 'Elena' });
    assert.equal(directive.type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(directive.document.version, '2024.3');
    assert.ok(directive.document.layouts.SignalRow && directive.document.layouts.BeeSourceBadge);
    const skillCopy = fs.readFileSync(path.join(__dirname, '..', '..', 'skill-package', 'assets', 'documents', 'wellnessSnapshot.json'), 'utf8');
    assert.deepEqual(directive.document, JSON.parse(skillCopy));
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
    assert.equal(signals.mood, undefined);
});

// --- Signal extraction ---

test('extractSignalsFromText detects each supported signal once', () => {
    const signals = extractSignalsFromText([
        'I feel drained', 'I slept badly', 'I am stressed', 'I am not hungry', 'I felt dizzy', 'my back aches', 'so tired'
    ]).map(item => item.signal);
    assert.deepEqual(signals, ['tiredness', 'sleep', 'mood', 'appetite', 'dizziness', 'discomfort']);
    assert.deepEqual(extractSignalsFromText(['I had a great day and went painting']), []);
});

test('extractSignalsFromText derives intensity from keywords', () => {
    const intensity = text => extractSignalsFromText([text])[0].intensity;
    assert.equal(intensity('I am completely exhausted'), 'high');
    assert.equal(intensity('I feel very tired'), 'moderate');
    assert.equal(intensity('I am tired'), 'low');
});

test('selectWearerTexts keeps only the wearer and confirmed facts', () => {
    const { texts, ignored } = selectWearerTexts(BEE_EXPORT);
    assert.deepEqual(texts, ['Elena felt completely exhausted after lunch', 'I am very anxious about the appointment']);
    assert.deepEqual(ignored, { unconfirmedFacts: 1, otherSpeakerUtterances: 1 });
});

// --- Consent and linking ---

test('ingestion is refused without a valid, active link code', async () => {
    await assert.rejects(() => ingestBeeContext({ beeExport: BEE_EXPORT }), /link code is invalid/);
    await assert.rejects(() => ingestBeeContext({ linkCode: 'ABCD-EFGH', beeExport: BEE_EXPORT }), /link code is invalid/);
    const code = await linkedCode();
    await revokeBeeConsent({ ownerId: 'bee-owner', memberName: 'Elena' });
    await assert.rejects(() => ingestBeeContext({ linkCode: code, beeExport: BEE_EXPORT }), /link code is invalid/);
});

test('an expired Bee consent stops ingestion', async t => {
    const code = await linkedCode();
    const realNow = Date.now();
    t.mock.method(Date, 'now', () => realNow + 31 * 24 * 60 * 60 * 1000);
    await assert.rejects(() => ingestBeeContext({ linkCode: code, beeExport: BEE_EXPORT }), /link code is invalid/);
});

test('linking again invalidates the previous code', async () => {
    const first = await linkedCode();
    const second = await linkedCode();
    await assert.rejects(() => resolveBeeLink(first), /link code is invalid/);
    assert.equal((await resolveBeeLink(second.toLowerCase().replace('-', ' '))).ownerId, 'bee-owner');
});

// --- Ingestion ---

test('ingestion stores only derived signals for the linked member', async () => {
    const result = await ingestBeeContext({ linkCode: await linkedCode(), beeExport: BEE_EXPORT });
    assert.deepEqual(result, {
        success: true,
        eventsIngested: 3,
        signalsDetected: ['tiredness', 'mood', 'sleep'],
        skipped: 0,
        ignored: { unconfirmedFacts: 1, otherSpeakerUtterances: 1 },
        errors: []
    });

    const history = await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.equal(history.length, 3);
    assert.ok(history.every(event => event.provenance === 'bee' && event.beeConsentId));
    assert.equal(history.find(event => event.signal === 'sleep').state, 'high');
    assert.equal(history.find(event => event.signal === 'tiredness').state, 'high');
    assert.equal(history.find(event => event.signal === 'mood').state, 'moderate');
    assert.doesNotMatch(JSON.stringify(history), /exhausted|anxious|appointment|dizzy|appetite/);

    const ninetyDays = 90 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(history.every(event => Math.abs(event.expiresAt - (now + ninetyDays)) < 60));
});

test('re-ingesting the same Bee export is idempotent', async () => {
    const linkCode = await linkedCode();
    await ingestBeeContext({ linkCode, beeExport: BEE_EXPORT });
    const again = await ingestBeeContext({ linkCode, beeExport: BEE_EXPORT });
    assert.equal(again.eventsIngested, 0);
    assert.equal(again.skipped, 3);
    assert.equal((await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' })).length, 3);
});

test('ingestion uses the stored sleep baseline and rejects malformed exports', async () => {
    const linkCode = await linkedCode();
    await ingestBeeContext({ linkCode, beeExport: { exportedAt: new Date().toISOString(), healthKit: { sleepHours: 7.2 } } });
    const [sleep] = await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.equal(sleep.state, 'low'); // baseline 7.5 h
    await assert.rejects(() => ingestBeeContext({ linkCode, beeExport: { facts: [] } }), /exportedAt/);
    await assert.rejects(
        () => ingestBeeContext({ linkCode, beeExport: { exportedAt: new Date().toISOString(), healthKit: { sleepHours: 30 } } }),
        /sleepHours/
    );
});

test('revoking Bee deletes Bee signals but keeps voice reports', async () => {
    await mcp.logWellnessEvent({ ownerId: 'bee-owner', memberName: 'Elena', signal: 'tiredness', state: 'reported' });
    await ingestBeeContext({ linkCode: await linkedCode(), beeExport: BEE_EXPORT });
    const result = await revokeBeeConsent({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.deepEqual(result, { revoked: true, eventsDeleted: 3 });
    const history = await mcp.getWellnessHistory({ ownerId: 'bee-owner', memberName: 'Elena' });
    assert.equal(history.length, 1);
    assert.equal(history[0].provenance, 'voice');
});

test('MCP gateway ingests with a link code and cannot target another owner directly', async () => {
    process.env.MCP_API_KEY = 'test-mcp-key';
    const call = body => mcpHttpHandler({
        headers: { 'x-carepulse-mcp-key': 'test-mcp-key', ...(body.sessionId ? { 'mcp-session-id': body.sessionId } : {}) },
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, method: body.method, params: body.params })
    });
    const init = await call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const sessionId = init.headers['mcp-session-id'];

    const list = JSON.parse((await call({ sessionId, id: 2, method: 'tools/list', params: {} })).body);
    assert.deepEqual(list.result.tools.find(tool => tool.name === 'ingest_bee_context').inputSchema.required, ['linkCode', 'beeExport']);

    const forged = JSON.parse((await call({
        sessionId, id: 3, method: 'tools/call',
        params: { name: 'ingest_bee_context', arguments: { ownerId: 'victim', memberName: 'Elena', beeExport: BEE_EXPORT } }
    })).body);
    assert.equal(forged.result.isError, true);
    assert.equal((await mcp.getWellnessHistory({ ownerId: 'victim', memberName: 'Elena' })).length, 0);

    const linkCode = await linkedCode('mcp-owner');
    const response = JSON.parse((await call({
        sessionId, id: 4, method: 'tools/call',
        params: { name: 'ingest_bee_context', arguments: { linkCode, beeExport: BEE_EXPORT } }
    })).body);
    assert.equal(response.result.isError, false);
    assert.equal(response.result.structuredContent.eventsIngested, 3);
});

// --- Alexa voice flow ---

test('interaction model exposes the Bee link and unlink intents', () => {
    const modelPath = path.join(__dirname, '..', '..', 'skill-package', 'interactionModels', 'custom', 'en-US.json');
    const intents = JSON.parse(fs.readFileSync(modelPath, 'utf8')).interactionModel.languageModel.intents.map(intent => intent.name);
    assert.ok(intents.includes('LinkBeeIntent'));
    assert.ok(intents.includes('UnlinkBeeIntent'));
});

test('declining Bee consent creates no link', async () => {
    const userId = `bee-decline-${Date.now()}`;
    const asked = await invokeAlexa(alexaRequest({ userId, intentName: 'LinkBeeIntent' }));
    assert.match(asked.response.outputSpeech.ssml, /never recordings or transcripts/);
    assert.match(asked.response.outputSpeech.ssml, /What other people say is ignored/);
    const declined = await invokeAlexa(alexaRequest({ userId, intentName: 'AMAZON.NoIntent', attributes: asked.sessionAttributes }));
    assert.match(declined.response.outputSpeech.ssml, /will not use any Bee data/);
    assert.equal(declined.response.card, undefined);
});

test('voice flow links Bee, shows Bee data on the card, then unlinks and deletes it', async () => {
    const userId = `bee-flow-${Date.now()}`;
    const asked = await invokeAlexa(alexaRequest({ userId, intentName: 'LinkBeeIntent' }));
    const granted = await invokeAlexa(alexaRequest({ userId, intentName: 'AMAZON.YesIntent', attributes: asked.sessionAttributes }));
    assert.match(granted.response.outputSpeech.ssml, /link code to the Alexa app/);
    const linkCode = granted.response.card.content.match(/Link code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
    assert.doesNotMatch(granted.response.outputSpeech.ssml, new RegExp(linkCode));

    await ingestBeeContext({ linkCode, beeExport: BEE_EXPORT });
    const screen = await invokeAlexa(alexaRequest({
        userId,
        intentName: 'GetWellnessSummaryIntent',
        supportedInterfaces: { 'Alexa.Presentation.APL': {} }
    }));
    const data = screen.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument').datasources.wellnessData;
    assert.equal(data.hasBeeData, true);
    assert.equal(data.signals.sleep.value, '5 h');
    assert.equal(data.signals.sleep.source, 'Bee 🐝');
    assert.equal(data.signals.energy.source, 'Bee 🐝');
    assert.equal(data.signals.appetite.value, 'No data');

    const unlinkAsked = await invokeAlexa(alexaRequest({ userId, intentName: 'UnlinkBeeIntent' }));
    const unlinked = await invokeAlexa(alexaRequest({ userId, intentName: 'AMAZON.YesIntent', attributes: unlinkAsked.sessionAttributes }));
    assert.match(unlinked.response.outputSpeech.ssml, /deleted 3 wellness signals/);
    await assert.rejects(() => ingestBeeContext({ linkCode, beeExport: BEE_EXPORT }), /link code is invalid/);

    const after = await invokeAlexa(alexaRequest({ userId, intentName: 'GetWellnessSummaryIntent', supportedInterfaces: { 'Alexa.Presentation.APL': {} } }));
    assert.equal(after.response.directives[0].datasources.wellnessData.hasBeeData, false);
});

test('unlinking when Bee was never linked says there is nothing to remove', async () => {
    const userId = `bee-none-${Date.now()}`;
    const asked = await invokeAlexa(alexaRequest({ userId, intentName: 'UnlinkBeeIntent' }));
    const done = await invokeAlexa(alexaRequest({ userId, intentName: 'AMAZON.YesIntent', attributes: asked.sessionAttributes }));
    assert.match(done.response.outputSpeech.ssml, /no Bee data to remove/);
});

// --- Schema report script ---

test('bee_schema_report prints field structure without any values', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bee-schema-')), 'facts.json');
    fs.writeFileSync(file, JSON.stringify({ facts: [{ id: 42, text: 'secret diagnosis', confirmed: true }], next_cursor: null }));
    const script = path.join(__dirname, '..', '..', 'scripts', 'bee_schema_report.js');
    const output = execFileSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.match(output, /facts\[\]\.text: string/);
    assert.match(output, /facts\[\]\.confirmed: boolean/);
    assert.match(output, /next_cursor: null/);
    assert.doesNotMatch(output, /secret|diagnosis|42/);
});

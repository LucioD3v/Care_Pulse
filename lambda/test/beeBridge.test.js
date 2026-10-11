'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const bridge = require(path.join(__dirname, '..', '..', 'scripts', 'bee_bridge.js'));
const { handler: mcpHttpHandler } = require('../mcp_http');
const { handler: alexaHandler } = require('../index');
const { grantBeeConsent } = require('../bee_link');
const mcp = require('../care_service');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
    delete process.env.CARE_TABLE_NAME;
    delete process.env.DEMO_OWNER_ID;
    process.env.MCP_API_KEY = 'bridge-test-key';
    mcp.resetMockRecords();
});

function beeData(now = Date.now()) {
    return {
        '/v1/facts': {
            facts: [
                { id: 1, text: 'I am completely exhausted lately', confirmed: true, created_at: new Date(now - HOUR).toISOString() },
                { id: 2, text: 'I have no appetite', confirmed: false, created_at: new Date(now - HOUR).toISOString() },
                { id: 3, text: 'I was tired last month', confirmed: true, created_at: new Date(now - 30 * DAY).toISOString() }
            ]
        },
        '/v1/conversations': {
            conversations: [
                { id: 'c1', start_time: now - 2 * HOUR },
                { id: 'c2', start_time: new Date(now - 40 * DAY).toISOString() }
            ]
        },
        '/v1/conversations/c1': {
            conversation: {
                id: 'c1',
                transcriptions: [{
                    utterances: [
                        { speaker: '1', text: 'I feel very anxious today' },
                        { speaker: '2', text: 'I am dizzy and in pain' }
                    ]
                }]
            }
        }
    };
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startServers(t, routes = beeData()) {
    const beeRequests = [];
    const mcpBodies = [];
    const bee = http.createServer((request, response) => {
        beeRequests.push(request.url);
        const body = routes[request.url];
        response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body || { error: 'not found' }));
    });
    const carePulse = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        mcpBodies.push(body);
        const result = await mcpHttpHandler({ headers: request.headers, requestContext: { http: { method: request.method } }, body });
        response.writeHead(result.statusCode, result.headers || {});
        response.end(result.body || '');
    });
    const beeUrl = await listen(bee);
    const mcpUrl = `${await listen(carePulse)}/mcp`;
    t.after(() => { bee.close(); carePulse.close(); });
    return { beeUrl, mcpUrl, beeRequests, mcpBodies };
}

function options(overrides) {
    return {
        ...bridge.parseArgs([], {}),
        mcpKey: 'bridge-test-key',
        wearerSpeakers: ['1'],
        ...overrides
    };
}

const quiet = () => {};

test('parseArgs reads flags and environment, and never takes the key from flags', () => {
    const parsed = bridge.parseArgs(
        ['--bee-url', 'http://localhost:1', '--wearer-speaker', '1', '--since-days', '3', '--send'],
        { CAREPULSE_MCP_KEY: 'k', BEE_WEARER_SPEAKERS: 'me' }
    );
    assert.deepEqual(parsed.wearerSpeakers, ['me', '1']);
    assert.equal(parsed.sinceDays, 3);
    assert.equal(parsed.send, true);
    assert.equal(parsed.mcpKey, 'k');
    assert.throws(() => bridge.parseArgs(['--mcp-key', 'x'], {}), /Unknown option/);
    assert.throws(() => bridge.parseArgs(['--since-days', '-1'], {}), /positive number/);
});

test('helpers accept common Bee response shapes and timestamps', () => {
    assert.deepEqual(bridge.extractList([1], 'facts'), [1]);
    assert.deepEqual(bridge.extractList({ facts: [2] }, 'facts'), [2]);
    assert.deepEqual(bridge.extractList({ data: [3] }, 'facts'), [3]);
    assert.throws(() => bridge.extractList({ unexpected: true }, 'facts'), /bee_schema_report/);
    assert.equal(bridge.toIso(1760000000), new Date(1760000000 * 1000).toISOString());
    assert.equal(bridge.toIso(1760000000000), new Date(1760000000000).toISOString());
    assert.equal(bridge.toIso('nope'), null);
    assert.equal(bridge.findUtterances({ a: { b: [{ utterances: [{ text: 'x' }] }] } }).length, 1);
});

test('dry run reports counts without contacting CarePulse or printing text', async t => {
    const servers = await startServers(t);
    const lines = [];
    const result = await bridge.run(options({ beeUrl: servers.beeUrl }), line => lines.push(line));
    assert.equal(result.sent, false);
    assert.equal(result.items, 2);
    assert.deepEqual(result.stats, {
        confirmedFacts: 1, unconfirmedFacts: 1, wearerUtterances: 1, otherUtterances: 1,
        conversationsUsed: 1, outsideWindow: 1, withoutTimestamp: 0
    });
    assert.equal(servers.mcpBodies.length, 0);
    assert.ok(!servers.beeRequests.includes('/v1/conversations/c2'));
    assert.doesNotMatch(lines.join('\n'), /exhausted|anxious|dizzy|appetite/);
});

test('list-speakers shows labels so the member can pick their own', async t => {
    const servers = await startServers(t);
    const result = await bridge.run(options({ beeUrl: servers.beeUrl, listSpeakers: true, wearerSpeakers: [] }), quiet);
    assert.deepEqual(result.speakers, { 1: 1, 2: 1 });
});

test('send delivers only wearer lines and confirmed facts, end to end into the Alexa summary', async t => {
    const servers = await startServers(t);
    const userId = `bridge-user-${Date.now()}`;
    const envelope = {
        version: '1.0',
        session: { new: false, sessionId: 's', application: { applicationId: 'test' }, user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId }, device: { deviceId: 'd', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: { type: 'IntentRequest', requestId: 'r', timestamp: new Date().toISOString(), locale: 'en-US', intent: { name: 'GetWellnessSummaryIntent', confirmationStatus: 'NONE', slots: {} } }
    };
    const ownerId = require('../index')._private.ownerId({ requestEnvelope: envelope });
    const { linkCode } = await grantBeeConsent({ ownerId, memberName: 'Elena' });

    const first = await bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, linkCode, send: true }), quiet);
    assert.equal(first.items, 2);
    assert.equal(first.eventsIngested, 2);
    assert.deepEqual(first.signals.sort(), ['mood', 'tiredness']);

    const sent = servers.mcpBodies.join('\n');
    assert.match(sent, /anxious/);
    assert.doesNotMatch(sent, /dizzy|pain|appetite|last month/);

    const second = await bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, linkCode, send: true }), quiet);
    assert.equal(second.eventsIngested, 0);
    assert.equal(second.skipped, 2);

    const response = await new Promise((resolve, reject) => {
        alexaHandler(envelope, {}, (error, result) => error ? reject(error) : resolve(result));
    });
    const data = response.response.directives[0].datasources.wellnessData;
    assert.equal(data.hasBeeData, true);
    assert.equal(data.signals.energy.source, 'Bee 🐝');
    assert.equal(data.signals.mood.source, 'Bee 🐝');
});

test('without a wearer speaker, conversations are never sent', async t => {
    const servers = await startServers(t);
    const { linkCode } = await grantBeeConsent({ ownerId: 'bridge-owner', memberName: 'Elena' });
    const result = await bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, linkCode, send: true, wearerSpeakers: [] }), quiet);
    assert.equal(result.items, 1);
    assert.doesNotMatch(servers.mcpBodies.join('\n'), /anxious|dizzy/);
});

test('send fails clearly on missing link code, wrong key, or revoked link', async t => {
    const servers = await startServers(t);
    await assert.rejects(
        () => bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, send: true }), quiet),
        /Missing --link-code/
    );
    await assert.rejects(
        () => bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, linkCode: 'ABCD-2345', send: true, mcpKey: 'wrong' }), quiet),
        /rejected the MCP key/
    );
    await assert.rejects(
        () => bridge.run(options({ beeUrl: servers.beeUrl, mcpUrl: servers.mcpUrl, linkCode: 'ABCD-2345', send: true }), quiet),
        /link code is invalid/
    );
});

test('a stopped or logged-out Bee proxy gives an actionable error', async t => {
    const servers = await startServers(t, {});
    await assert.rejects(() => bridge.run(options({ beeUrl: servers.beeUrl }), quiet), /bee proxy.*bee status/);
    await assert.rejects(() => bridge.run(options({ beeUrl: 'http://127.0.0.1:9' }), quiet), /Start it with "bee proxy"/);
});

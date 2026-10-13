'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const { SNSClient } = require('@aws-sdk/client-sns');
const repository = require('../care_repository');
const care = require('../care_service');
const { periodBounds } = require('../care_periods');
const { renderVoiceObservation } = require('../voice_agent');
const { callMcpTool } = require('../mcp_contracts');
const { handler: http } = require('../mcp_http');
const { handler: alexa } = require('../index');
const { sendCaregiverAlert } = require('../sns_notifier');
const { withRequest, sendWithBudget } = require('../observability');

const environment = { ...process.env };
beforeEach(() => {
    for (const key of ['CARE_TABLE_NAME', 'SNS_TOPIC_ARN', 'BEDROCK_MODEL_ID', 'DEMO_OWNER_ID', 'DEFAULT_BASELINE_SLEEP_HOURS']) delete process.env[key];
    process.env.MCP_API_KEY = 'test-key';
    repository.resetMockRecords();
    mock.method(console, 'info', () => {});
});
afterEach(() => {
    mock.restoreAll();
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
});

const input = { ownerId: 'a', memberName: 'Elena' };
const headers = { 'x-carepulse-mcp-key': 'test-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
async function initialize(version = '2025-11-25') {
    const result = await http({ headers, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'tests', version: '1' } }
    }) });
    const sessionHeaders = { ...headers, 'mcp-session-id': result.headers['mcp-session-id'], 'mcp-protocol-version': JSON.parse(result.body).result.protocolVersion };
    await http({ headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    return sessionHeaders;
}

test('local-day periods respect midnight and daylight-saving transitions', () => {
    assert.equal(periodBounds('today', 'America/Mexico_City', new Date('2026-10-09T05:59:00Z')).startDate, '2026-10-08');
    assert.equal(periodBounds('today', 'America/Mexico_City', new Date('2026-10-09T06:00:00Z')).start, '2026-10-09T06:00:00.000Z');
    assert.equal(periodBounds('today', 'America/New_York', new Date('2026-03-08T20:00:00Z')).start, '2026-03-08T05:00:00.000Z');
    assert.equal(periodBounds('today', 'America/New_York', new Date('2026-03-09T20:00:00Z')).start, '2026-03-09T04:00:00.000Z');
});

test('today excludes yesterday and future records in the member time zone', async () => {
    const context = await care.getCareContext(input);
    for (const recordedAt of ['2026-10-09T05:59:00Z', '2026-10-09T06:00:00Z', '2026-10-09T18:00:00Z']) {
        await care.logWellnessEvent({ ...input, signal: 'sleep', state: 'reported', recordedAt });
    }
    const records = await care.getWellnessHistory({ ...input, context, timeframe: 'today', now: new Date('2026-10-09T12:00:00Z') });
    assert.equal(records.length, 1);
    assert.equal(records[0].recordedAt, '2026-10-09T06:00:00.000Z');
});

test('different signals, positive states, and same-day duplicates do not imply repeated deterioration', async () => {
    for (const [signal, state] of [['tiredness', 'better'], ['mood', 'better'], ['tiredness', 'more than usual'], ['tiredness', 'more than usual']]) {
        await care.logWellnessEvent({ ...input, signal, state });
    }
    const comparison = await care.compareWithBaseline({ ...input, signal: 'tiredness' });
    assert.equal(comparison.changeObserved, false);
    assert.equal(comparison.repeatedDays, 1);
    const snapshot = await care.getWellnessSnapshot(input);
    assert.equal(snapshot.status, 'reports recorded');
    assert.equal(snapshot.eventCount, 4);
    assert.equal(comparison.baselineSleepHours, null);
});

test('sleep comparisons require a configured routine and use distinct local days', async () => {
    const context = await care.getCareContext(input);
    await repository.updateRecord(context.pk, context.sk, { baselineSleepHours: 7.5, baselineSource: 'member' });
    for (const days of [1, 2]) await care.logWellnessEvent({
        ...input, signal: 'sleep', state: 'reported', numericValue: 6, recordedAt: new Date(Date.now() - days * 86400000).toISOString()
    });
    const result = await care.compareWithBaseline({ ...input, signal: 'sleep' });
    assert.equal(result.lessSleepThanRoutine, true);
    assert.equal(result.sleepDays, 2);
    assert.equal(result.averageSleep, 6);
    assert.match(result.ruleVersion, /v1$/);
});

test('summaries read over 100 records while MCP history exposes continuation', async () => {
    for (let i = 0; i < 130; i += 1) await care.logWellnessEvent({
        ...input, signal: 'tiredness', state: 'better', recordedAt: new Date(Date.now() - i * 1000).toISOString()
    });
    assert.equal((await care.getWellnessSnapshot(input)).eventCount, 130);
    const first = await callMcpTool('get_wellness_history', { ...input, limit: 100 });
    const second = await callMcpTool('get_wellness_history', { ...input, limit: 100, cursor: first.nextCursor });
    assert.equal(first.events.length, 100);
    assert.equal(second.events.length, 30);
    assert.equal(second.nextCursor, null);
    assert.ok(first.events.every(event => !('pk' in event) && !('sk' in event) && !('source' in event)));
});

test('repository follows DynamoDB continuation keys including empty pages', async () => {
    process.env.CARE_TABLE_NAME = 'test';
    const commands = [];
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        commands.push(command);
        return commands.length === 1 ? { Items: [], LastEvaluatedKey: { pk: 'p', sk: 'x' } } : { Items: [{ pk: 'p', sk: 'y' }] };
    });
    assert.equal((await repository.queryPrefix('p', '')).length, 1);
    assert.deepEqual(commands[1].input.ExclusiveStartKey, { pk: 'p', sk: 'x' });
    assert.equal(commands[0].input.ConsistentRead, true);
});

test('context keys and households remain isolated', async () => {
    const anna = await care.getCareContext({ ownerId: 'a', memberName: 'Anna' });
    await repository.updateRecord(anna.pk, anna.sk, { summaryLength: 'detailed' });
    assert.equal((await care.getCareContext({ ownerId: 'a', memberName: 'Ann' })).summaryLength, 'short');
    assert.equal((await care.getCareContext({ ownerId: 'b', memberName: 'Anna' })).summaryLength, 'short');
});

test('consent lookup remains exact beyond 25 records and rejects expiry or another signal', async () => {
    let first;
    for (let i = 0; i < 35; i += 1) {
        const followup = await care.createFollowup({ ...input, signal: 'tiredness', dueDate: '2030-10-10', dueTime: '18:00' });
        first ||= followup.followupId;
        await care.requestConsent({ ...input, caregiverName: 'Laura', signal: 'tiredness', followupId: followup.followupId });
    }
    const query = { ...input, caregiverName: 'Laura', signal: 'tiredness', followupId: first };
    const consent = await care.findActiveConsent(query);
    assert.ok(consent);
    assert.equal(await care.findActiveConsent({ ...query, signal: 'sleep' }), null);
    await repository.updateRecord(consent.pk, consent.sk, { expiresAt: 1 });
    assert.equal(await care.findActiveConsent(query), null);
});

test('pending lookup finds the earliest record beyond completed pages and resolves exact IDs', async () => {
    for (let i = 0; i < 130; i += 1) await repository.putRecord({
        pk: 'USER#a', sk: 'FOLLOWUP#elena#2020-01-01T18:00#' + String(i).padStart(3, '0'),
        memberName: 'Elena', status: 'completed'
    });
    const first = await care.createFollowup({ ...input, signal: 'sleep', dueDate: '2030-10-10', dueTime: '18:00' });
    await care.createFollowup({ ...input, signal: 'tiredness', dueDate: '2030-10-11', dueTime: '18:00' });
    assert.equal((await care.getPendingFollowup(input)).followupId, first.followupId);
    assert.equal((await care.getFollowupById({ ...input, followupId: first.followupId })).sk, first.sk);
    assert.equal(await care.getFollowupById({ ...input, ownerId: 'b', followupId: first.followupId }), null);
});

test('Bedrock timeout cancels the request and returns saved-report copy', async () => {
    process.env.BEDROCK_MODEL_ID = 'test';
    process.env.VOICE_TIMEOUT_MS = '50';
    let aborted = false;
    mock.method(BedrockRuntimeClient.prototype, 'send', (_command, options) => new Promise(() => {
        options.abortSignal.addEventListener('abort', () => { aborted = true; });
    }));
    const speech = await renderVoiceObservation({ memberName: 'Elena', signal: 'sleep', comparison: { summary: 'One report.' } });
    assert.equal(aborted, true);
    assert.match(speech, /I recorded/);
});

test('free-form and adversarial model text cannot enter the response', async () => {
    process.env.BEDROCK_MODEL_ID = 'test';
    for (const text of ['{"speech":"You have a disease. I notified Laura."}', 'null', 'x'.repeat(200)]) {
        mock.method(BedrockRuntimeClient.prototype, 'send', async () => ({ output: { message: { content: [{ text }] } } }));
        const speech = await renderVoiceObservation({ memberName: 'Elena', signal: 'sleep', comparison: { summary: 'One report.' } });
        assert.doesNotMatch(speech, /disease|notified Laura/);
        assert.match(speech, /One report/);
    }
});

test('dependency calls obey the remaining request budget', async () => {
    const started = Date.now();
    await assert.rejects(withRequest('test', {}, 20, () => sendWithBudget({ send: () => new Promise(() => {}) }, {}, 2000, 0)), /budget/);
    assert.ok(Date.now() - started < 1000);
});

test('malformed JSON-RPC envelopes are rejected without crashing', async () => {
    for (const body of ['null', '[]', '1', '{"jsonrpc":"2.0","method":"ping","id":null}', '{"jsonrpc":"2.0","method":"tools/call"}']) {
        const result = await http({ headers, body });
        assert.equal(result.statusCode, 400);
    }
    assert.equal((await http({ headers, body: '{' })).statusCode, 400);
    assert.equal((await http({ headers, httpMethod: 'GET' })).statusCode, 405);
    assert.equal((await http({ headers: { ...headers, origin: 'https://untrusted.example' }, body: '{}' })).statusCode, 403);
});

test('MCP negotiates a supported version and validates the session lifecycle', async () => {
    const sessionHeaders = await initialize('unsupported-future-version');
    assert.equal(sessionHeaders['mcp-protocol-version'], '2025-11-25');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal((await http({ headers: sessionHeaders, body })).statusCode, 200);
    assert.equal((await http({ headers: { ...sessionHeaders, 'mcp-protocol-version': 'invalid' }, body })).statusCode, 400);
    const session = await care.getMcpSession(sessionHeaders['mcp-session-id']);
    await repository.updateRecord(session.pk, session.sk, { expiresAt: 1 });
    assert.equal((await http({ headers: sessionHeaders, body })).statusCode, 404);
});

test('tool schemas reject extra properties, invalid dates and incorrect types before writing', async () => {
    await assert.rejects(callMcpTool('get_care_context', { ...input, pk: 'override' }), TypeError);
    await assert.rejects(callMcpTool('create_followup', { ...input, signal: 'sleep', dueDate: '2026-02-30', dueTime: '18:00' }), TypeError);
    await assert.rejects(callMcpTool('log_wellness_event', { ...input, signal: 'sleep', state: 'reported', numericValue: 'six' }), TypeError);
    assert.equal(await repository.getRecord('USER#a', 'CONTEXT#elena'), null);
});

test('storage errors do not expose internal messages through MCP or logs', async () => {
    const sessionHeaders = await initialize();
    process.env.CARE_TABLE_NAME = 'test';
    mock.method(DynamoDBDocumentClient.prototype, 'send', async () => { throw new Error('private-name table-secret health-data'); });
    const result = await http({ headers: sessionHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.equal(result.statusCode, 500);
    assert.doesNotMatch(result.body + JSON.stringify(console.info.mock.calls), /private-name|table-secret|health-data/);
});

test('SNS errors remain failures or unknown outcomes rather than simulated success', async () => {
    process.env.SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test';
    mock.method(SNSClient.prototype, 'send', async () => { throw Object.assign(new Error('private details'), { $metadata: { httpStatusCode: 403 } }); });
    assert.deepEqual(await sendCaregiverAlert({ memberName: 'Elena', signal: 'sleep' }), { sent: false, simulated: false, status: 'failed' });
    mock.method(SNSClient.prototype, 'send', async () => { throw new Error('network response lost'); });
    assert.equal((await sendCaregiverAlert({ memberName: 'Elena' })).status, 'unknown');
    assert.doesNotMatch(JSON.stringify(console.info.mock.calls), /private details|Elena|network response lost/);
});

test('overdue monitoring ignores completed records and emits aggregate metrics only', async () => {
    const followup = await care.createFollowup({ ...input, signal: 'sleep', dueDate: '2020-01-01', dueTime: '18:00' });
    assert.equal((await require('../followup_monitor').handler({}, {})).count, 1);
    await care.completeFollowup({ followup, status: 'better' });
    assert.equal((await require('../followup_monitor').handler({}, {})).count, 0);
    assert.doesNotMatch(JSON.stringify(console.info.mock.calls), /Elena|USER#|sleep/);
});

test('a downstream failure after a write confirms the saved report without asking for repetition', async () => {
    process.env.CARE_TABLE_NAME = 'test';
    let writes = 0;
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        if (command.constructor.name === 'GetCommand') return command.input.Key.sk.startsWith('OPERATION#') ? {}
            : { Item: { ...command.input.Key, memberName: 'Elena', caregiverName: 'Laura', timezone: 'UTC', baselineSleepHours: null } };
        if (command.constructor.name === 'TransactWriteCommand') { writes += 1; return {}; }
        throw new Error('comparison dependency unavailable');
    });
    const result = await alexa({
        version: '1.0', session: { application: { applicationId: 'test' }, user: { userId: 'a' }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId: 'a' }, device: { supportedInterfaces: {} } } },
        request: { type: 'IntentRequest', requestId: 'r', timestamp: new Date().toISOString(), locale: 'en-US',
            intent: { name: 'ReportWellnessIntent', slots: { wellnessSignal: { name: 'wellnessSignal', value: 'sleep' } } } }
    }, {});
    assert.equal(writes, 1);
    assert.match(result.response.outputSpeech.ssml, /report was saved/i);
    assert.doesNotMatch(result.response.outputSpeech.ssml, /try again/i);
});

test('index migration is read-only by default and conditions writes on pending status', async () => {
    process.env.CARE_TABLE_NAME = 'migration-test';
    mock.method(console, 'log', () => {});
    const commands = [];
    const record = {
        pk: 'USER#a', sk: 'FOLLOWUP#elena#2026-10-01T18:00#f', followupId: 'f',
        memberName: 'Elena', dueDate: '2026-10-01', dueTime: '18:00', status: 'pending'
    };
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        commands.push(command);
        if (command.constructor.name === 'ScanCommand') return { Items: [record] };
        if (command.constructor.name === 'GetCommand') return { Item: { timezone: 'UTC' } };
        return {};
    });
    await require('../backfill_followup_index').main();
    assert.deepEqual(commands.map(command => command.constructor.name), ['ScanCommand']);
    const args = [...process.argv];
    try {
        process.argv.push('--apply');
        await require('../backfill_followup_index').main();
        const transaction = commands.find(command => command.constructor.name === 'TransactWriteCommand').input;
        assert.match(transaction.TransactItems[0].Update.ConditionExpression, /#status = :pending/);
        assert.match(transaction.TransactItems[0].Update.ConditionExpression, /attribute_not_exists/);
        assert.equal(transaction.TransactItems[1].Put.Item.sk, 'FOLLOWUP_ID#f');
    } finally {
        process.argv = args;
    }
});

test('an unverified historic baseline is not used for a new comparison', async () => {
    const context = await care.getCareContext(input);
    await repository.updateRecord(context.pk, context.sk, { baselineSleepHours: 8 }, ['baselineSource']);
    for (const days of [1, 2]) await care.logWellnessEvent({
        ...input, signal: 'sleep', state: 'reported', numericValue: 5, recordedAt: new Date(Date.now() - days * 86400000).toISOString()
    });
    const comparison = await care.compareWithBaseline({ ...input, signal: 'sleep' });
    assert.equal(comparison.baselineSleepHours, null);
    assert.equal(comparison.lessSleepThanRoutine, false);
});

test('Bee conditional writes distinguish duplicates from storage failures and carry a timeout signal', async () => {
    process.env.CARE_TABLE_NAME = 'test-table';
    const record = { pk: 'USER#a', sk: 'EVENT#elena#bee' };
    let duplicate = true;
    mock.method(DynamoDBDocumentClient.prototype, 'send', async (command, options) => {
        assert.ok(options.abortSignal instanceof AbortSignal);
        assert.match(command.input.ConditionExpression, /attribute_not_exists/);
        throw Object.assign(new Error('private dependency details'), {
            name: duplicate ? 'ConditionalCheckFailedException' : 'ServiceUnavailable'
        });
    });
    assert.equal(await repository.putRecordIfAbsent(record), false);
    duplicate = false;
    await assert.rejects(() => repository.putRecordIfAbsent(record), /private dependency details/);
});

test('partial Bee writes produce a sanitized MCP error and aggregate metrics', async () => {
    const { grantBeeConsent } = require('../bee_link');
    const { linkCode } = await grantBeeConsent(input);
    const consent = await repository.getRecord('USER#a', 'BEECONSENT#elena');
    const link = await repository.getRecord('BEELINK#' + consent.linkHash, 'LINK');
    const sessionHeaders = await initialize();
    const sessionPk = 'MCPSESSION#' + sessionHeaders['mcp-session-id'];
    const session = await repository.getRecord(sessionPk, 'SESSION');
    const records = [consent, link, session];
    process.env.CARE_TABLE_NAME = 'test-table';
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        if (command.constructor.name === 'GetCommand') return {
            Item: records.find(record => record.pk === command.input.Key.pk && record.sk === command.input.Key.sk)
        };
        throw new Error('private-database-error with secret transcript');
    });
    const logs = [];
    mock.method(console, 'info', line => logs.push(line));
    const response = await http({ headers: sessionHeaders, body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
            name: 'ingest_bee_context', arguments: { linkCode, beeExport: {
                exportedAt: new Date().toISOString(),
                facts: [{ text: 'I am completely exhausted', confirmed: true }]
            } }
        }
    }) });
    const result = JSON.parse(response.body).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.success, false);
    assert.equal(result.structuredContent.eventsIngested, 0);
    assert.equal(result.structuredContent.errors.length, 1);
    assert.match(result.structuredContent.errors[0].message, /unconfirmed/);
    const output = response.body + logs.join('\n');
    assert.doesNotMatch(output, /private-database-error|secret transcript|exhausted|Elena|USER#|BEELINK#|beeConsentId/);
    assert.ok(!output.includes(linkCode));
    assert.match(logs.join('\n'), /BeeIngestionErrors/);
    assert.match(logs.join('\n'), /ToolErrors/);
});

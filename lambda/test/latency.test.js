'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { beforeEach, test } = require('node:test');
const YAML = require('yaml');
const latency = require(path.join(__dirname, '..', '..', 'scripts', 'measure_mcp_latency.js'));
const { handler } = require('../mcp_http');
const { resetMockRecords } = require('../care_repository');

beforeEach(() => {
    process.env.MCP_API_KEY = 'latency-key';
    process.env.DEMO_OWNER_ID = 'latency-owner';
    resetMockRecords();
});

async function startGateway(t, delayMs = 0, { onlyInitialize = false } = {}) {
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        const slow = delayMs && (!onlyInitialize || body.includes('"method":"initialize"'));
        if (slow) await new Promise(resolve => setTimeout(resolve, delayMs));
        const result = await handler({ headers: request.headers, requestContext: { http: { method: request.method } }, body }, {});
        response.writeHead(result.statusCode, result.headers || {});
        response.end(result.body || '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}/mcp`;
}

test('percentiles use the nearest-rank method', () => {
    assert.deepEqual(latency.summarize([5, 1, 4, 2, 3]), { count: 5, p50: 3, p95: 5, max: 5 });
    assert.equal(latency.summarize(Array.from({ length: 100 }, (_, i) => i + 1)).p95, 95);
});

test('options come from flags and environment, never credentials from flags', () => {
    const options = latency.parseArgs(['--mcp-url', 'https://x/mcp', '--requests', '5'], { CAREPULSE_MCP_TOKEN: 't' });
    assert.equal(options.requests, 5);
    assert.equal(options.token, 't');
    assert.throws(() => latency.parseArgs(['--token', 'secret'], {}), /Unknown option/);
    assert.throws(() => latency.parseArgs(['--requests', '0'], {}), /positive integer/);
});

test('measures a live MCP session end to end and passes under the limit', async t => {
    const mcpUrl = await startGateway(t);
    const lines = [];
    const result = await latency.run({ mcpUrl, key: 'latency-key', requests: 3, member: 'Elena', limitMs: 5000 }, line => lines.push(line));
    assert.equal(result.passed, true);
    for (const name of ['ping', 'tools/list', 'get_care_context']) assert.equal(result[name].count, 3);
    assert.match(lines.join('\n'), /PASS: first request [\d.]+ ms and worst p95/);
});

test('a slow first request (cold start) fails the run even when later calls are fast', async t => {
    const mcpUrl = await startGateway(t, 400, { onlyInitialize: true });
    const lines = [];
    const result = await latency.run({ mcpUrl, key: 'latency-key', requests: 3, member: 'Elena', limitMs: 300 }, line => lines.push(line));
    assert.ok(result.worstP95 < 300, 'warm calls are under the limit');
    assert.ok(result.first >= 300, 'the initialize round trip is slow');
    assert.equal(result.passed, false);
    assert.match(lines.join('\n'), /FAIL: first request [\d.]+ ms not under 300 ms\. If only the first request is slow, enable provisioned concurrency/);
});

test('reports FAIL when round trips exceed the limit', async t => {
    const mcpUrl = await startGateway(t, 30);
    const result = await latency.run({ mcpUrl, key: 'latency-key', requests: 2, member: 'Elena', limitMs: 20 }, () => {});
    assert.equal(result.passed, false);
});

test('rejected credentials give an actionable error', async t => {
    const mcpUrl = await startGateway(t);
    await assert.rejects(latency.run({ mcpUrl, key: 'wrong', requests: 1, member: 'Elena', limitMs: 500 }, () => {}), /401/);
});

test('the MCP gateway does not load the SNS SDK during initialization', () => {
    const output = execFileSync(process.execPath, ['-e', `
        const Module = require('module'); const load = Module._load; const seen = [];
        Module._load = function (request) { if (request === '@aws-sdk/client-sns') seen.push(request); return load.apply(this, arguments); };
        require(${JSON.stringify(path.join(__dirname, '..', 'mcp_http'))});
        process.stdout.write(String(seen.length));
    `], { encoding: 'utf8', env: { ...process.env, CARE_MODE: 'demo', CARE_STORAGE_MODE: 'memory' } });
    assert.equal(output, '0');
});

test('Serverless sizes the MCP function and alarms near the Alexa+ latency limit', () => {
    const config = YAML.parse(fs.readFileSync(path.join(__dirname, '../../serverless.yml'), 'utf8'));
    const mcp = config.functions.mcpGateway;
    assert.match(String(mcp.memorySize), /mcpMemorySize.*1024/);
    assert.match(String(mcp.provisionedConcurrency), /mcpProvisionedConcurrency.*, 0\}$/);
    const alarm = config.resources.Resources.McpLatencyAlarm.Properties;
    assert.equal(alarm.MetricName, 'RequestDuration');
    assert.deepEqual(alarm.Dimensions[0], { Name: 'Service', Value: 'mcp' });
    assert.equal(alarm.ExtendedStatistic, 'p95');
    assert.ok(alarm.Threshold < 500);
    assert.equal(alarm.EvaluationPeriods, 3);
    assert.equal(alarm.DatapointsToAlarm, 2, 'one slow request in a quiet window must not alarm');
    // Handler time cannot see cold starts; API Gateway latency can.
    const endToEnd = config.resources.Resources.McpEndToEndLatencyAlarm.Properties;
    assert.equal(endToEnd.Namespace, 'AWS/ApiGateway');
    assert.equal(endToEnd.MetricName, 'Latency');
    assert.deepEqual(endToEnd.Dimensions[0], { Name: 'ApiId', Value: { Ref: 'HttpApi' } });
    assert.equal(endToEnd.Threshold, 500);
    assert.equal(endToEnd.DatapointsToAlarm, 2);
    // Scoped to POST /mcp so OAuth and discovery routes neither trigger nor dilute it.
    assert.deepEqual(endToEnd.Dimensions.map(d => d.Name), ['ApiId', 'Method', 'Resource', 'Stage']);
    assert.equal(endToEnd.Dimensions.find(d => d.Name === 'Method').Value, 'POST');
    assert.equal(endToEnd.Dimensions.find(d => d.Name === 'Resource').Value, '/mcp');
    assert.equal(config.provider.httpApi.metrics, true, 'route metrics are only sent when detailed metrics are on');
    const oauthErrors = config.resources.Resources.McpOAuthErrorsAlarm.Properties;
    assert.equal(oauthErrors.MetricName, 'ServiceErrors');
    assert.deepEqual(oauthErrors.Dimensions[0], { Name: 'Service', Value: 'mcp-oauth' });
});

test('limits compare unrounded times, so 499.6 ms passes a 500 ms limit', () => {
    assert.equal(latency.evaluate({ first: 499.6, worstP95: 120 }, 500).passed, true);
    assert.equal(latency.evaluate({ first: 500, worstP95: 120 }, 500).passed, false);
    assert.equal(latency.evaluate({ first: 120, worstP95: 499.9 }, 500).passed, true);
    assert.deepEqual(latency.evaluate({ first: 501.24, worstP95: 600 }, 500).failures, ['first request 501.2 ms', 'worst p95 600 ms']);
});

test('OAuth routes report metrics as mcp-oauth so MCP latency only covers MCP calls', async t => {
    const lines = [];
    t.mock.method(console, 'info', line => lines.push(String(line)));
    await handler({ rawPath: '/.well-known/oauth-protected-resource', headers: { host: 'h.example' },
        requestContext: { domainName: 'h.example', http: { method: 'GET', path: '/.well-known/oauth-protected-resource' } } }, {});
    const services = lines.filter(line => line.includes('RequestDuration')).map(line => JSON.parse(line).Service);
    assert.deepEqual(services, ['mcp-oauth']);
});

test('a failure mid-run still prints the results measured so far', async t => {
    let calls = 0;
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (body.includes('"method":"tools/list"') && ++calls > 1) {
            response.writeHead(502);
            return response.end();
        }
        const result = await handler({ headers: request.headers, requestContext: { http: { method: request.method } }, body }, {});
        response.writeHead(result.statusCode, result.headers || {});
        response.end(result.body || '');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const lines = [];
    await assert.rejects(latency.run({ mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`, key: 'latency-key', requests: 3,
        member: 'Elena', limitMs: 5000 }, line => lines.push(line)), /HTTP 502/);
    const output = lines.join('\n');
    assert.match(output, /partial results/);
    assert.match(output, /ping +n=3/);
    assert.match(output, /tools\/list +n=1/);
});

test('SNS is preloaded only in provisioned-concurrency environments', () => {
    const probe = initType => execFileSync(process.execPath, ['-e', `
        const Module = require('module'); const load = Module._load; let loaded = false;
        Module._load = function (request) { if (request === '@aws-sdk/client-sns') loaded = true; return load.apply(this, arguments); };
        require(${JSON.stringify(path.join(__dirname, '..', 'sns_notifier'))});
        process.stdout.write(String(loaded));
    `], { encoding: 'utf8', env: { ...process.env, CARE_MODE: 'demo', AWS_LAMBDA_INITIALIZATION_TYPE: initType } });
    assert.equal(probe('provisioned-concurrency'), 'true');
    assert.equal(probe('on-demand'), 'false');
});

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

async function startGateway(t, delayMs = 0) {
    const server = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
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
    assert.match(lines.join('\n'), /PASS: worst p95/);
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
});

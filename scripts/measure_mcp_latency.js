#!/usr/bin/env node
'use strict';

// Measures client-side MCP round trips against a deployed CarePulse gateway and checks them
// against the Alexa+ limit (< 500 ms). It calls ping, tools/list and get_care_context. It is not
// strictly read-only: opening the MCP session writes a session record, and in demo mode
// get_care_context creates a default context if the member does not exist yet.

const HELP = `Usage: node scripts/measure_mcp_latency.js --mcp-url <endpoint>/mcp [options]

Options:
  --requests <n>     Measured calls per method (default 20)
  --member <name>    Member for get_care_context (default Elena)
  --limit-ms <n>     Pass/fail threshold (default 500, the Alexa+ limit). The run fails if the
                     first request (initialize, which includes any cold start) or the worst p95
                     is not under it.
  --help             Show this help

Writes: opening the MCP session stores a session record. In demo mode, get_care_context
creates a default context when the member does not exist, so use an existing member.

Authentication comes from the environment only:
  CAREPULSE_MCP_TOKEN  OAuth access token (sent as Authorization: Bearer)
  CAREPULSE_MCP_KEY    Shared demo key (sent as x-carepulse-mcp-key)`;

const PROTOCOL_VERSION = '2025-11-25';

function parseArgs(argv, env = process.env) {
    const options = {
        mcpUrl: env.CAREPULSE_MCP_URL, token: env.CAREPULSE_MCP_TOKEN, key: env.CAREPULSE_MCP_KEY,
        requests: 20, member: 'Elena', limitMs: 500, help: false
    };
    const flags = {
        '--mcp-url': value => { options.mcpUrl = value; },
        '--requests': value => { options.requests = positiveInteger('--requests', value); },
        '--member': value => { options.member = value; },
        '--limit-ms': value => { options.limitMs = positiveInteger('--limit-ms', value); }
    };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h') { options.help = true; continue; }
        if (!flags[flag]) throw new Error(`Unknown option: ${flag}. Use --help.`);
        const value = argv[++index];
        if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
        flags[flag](value);
    }
    return options;
}

function positiveInteger(flag, value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer.`);
    return number;
}

function percentile(sorted, fraction) {
    return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) };
}

class Client {
    constructor({ mcpUrl, token, key }) {
        this.url = mcpUrl;
        this.auth = token ? { authorization: 'Bearer ' + token } : { 'x-carepulse-mcp-key': key };
        this.sessionId = null;
        this.nextId = 1;
    }

    async post(method, params, { notification = false } = {}) {
        const started = performance.now();
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-protocol-version': PROTOCOL_VERSION,
                ...this.auth,
                ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
            },
            body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: this.nextId++ }), method, ...(params ? { params } : {}) }),
            signal: AbortSignal.timeout(10000)
        });
        const text = await response.text();
        const elapsed = performance.now() - started;
        if (response.status === 401) throw new Error('CarePulse rejected the credentials (401). Check CAREPULSE_MCP_TOKEN or CAREPULSE_MCP_KEY.');
        if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}.`);
        const body = text ? JSON.parse(text) : null;
        if (body?.error) throw new Error(`${method} failed: ${body.error.message}`);
        return { elapsed, response, body };
    }

    async close() {
        if (!this.sessionId) return;
        await fetch(this.url, { method: 'DELETE', headers: { ...this.auth, 'mcp-session-id': this.sessionId } }).catch(() => {});
    }
}

async function run(options, log = console.log) {
    if (options.help) { log(HELP); return null; }
    if (!options.mcpUrl) throw new Error('Missing --mcp-url (the McpEndpoint output, ending in /mcp).');
    if (!options.token && !options.key) throw new Error('Set CAREPULSE_MCP_TOKEN or CAREPULSE_MCP_KEY.');

    const client = new Client(options);
    const results = {};
    try {
        const init = await client.post('initialize', {
            protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'carepulse-latency', version: '1.0.0' }
        });
        client.sessionId = init.response.headers.get('mcp-session-id');
        if (!client.sessionId) throw new Error('CarePulse did not return an MCP session.');
        results.first = Math.round(init.elapsed);
        await client.post('notifications/initialized', undefined, { notification: true });

        const methods = {
            ping: () => client.post('ping', {}),
            'tools/list': () => client.post('tools/list', {}),
            get_care_context: () => client.post('tools/call', { name: 'get_care_context', arguments: { memberName: options.member } })
        };
        for (const [name, call] of Object.entries(methods)) {
            const samples = [];
            for (let index = 0; index < options.requests; index++) {
                const { elapsed, body } = await call();
                if (body?.result?.isError) throw new Error(`${name} returned a tool error: ${body.result.content?.[0]?.text || 'unknown'}`);
                samples.push(elapsed);
            }
            results[name] = summarize(samples);
        }
    } finally {
        await client.close();
    }

    const worstP95 = Math.max(...['ping', 'tools/list', 'get_care_context'].map(name => results[name].p95));
    log(`First request (initialize, includes any cold start): ${results.first} ms`);
    for (const name of ['ping', 'tools/list', 'get_care_context']) {
        const { count, p50, p95, max } = results[name];
        log(`${name.padEnd(17)} n=${count}  p50 ${Math.round(p50)} ms  p95 ${Math.round(p95)} ms  max ${Math.round(max)} ms`);
    }
    // The first request carries any cold start, which is what Alexa+ would see on a cold function.
    const failures = [];
    if (!(results.first < options.limitMs)) failures.push(`first request ${results.first} ms`);
    if (!(worstP95 < options.limitMs)) failures.push(`worst p95 ${Math.round(worstP95)} ms`);
    const passed = failures.length === 0;
    log(passed ? `PASS: first request ${results.first} ms and worst p95 ${Math.round(worstP95)} ms are under ${options.limitMs} ms.`
        : `FAIL: ${failures.join(' and ')} not under ${options.limitMs} ms.${results.first >= options.limitMs
            ? ' If only the first request is slow, enable provisioned concurrency (mcpProvisionedConcurrency=1).' : ''}`);
    return { ...results, worstP95, passed };
}

module.exports = { parseArgs, summarize, run };

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
    run(options).then(result => {
        if (result && !result.passed) process.exitCode = 1;
    }).catch(error => {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    });
}

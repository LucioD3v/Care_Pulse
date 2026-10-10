#!/usr/bin/env node
'use strict';

// Bridge: reads the member's Bee data from the local Bee proxy (`bee proxy`)
// and sends wearer-only, confirmed context to CarePulse `ingest_bee_context`.
// Never prints or sends text spoken by other people.

const HELP = `Usage: node scripts/bee_bridge.js [options]

Reads Bee data from the local Bee proxy and sends it to CarePulse.
Without --send it only shows what would be sent (counts, never text).

Options:
  --bee-url <url>            Bee proxy URL shown by "bee proxy" (or BEE_PROXY_URL)
  --mcp-url <url>            CarePulse MCP endpoint, ending in /mcp (or CAREPULSE_MCP_URL)
  --link-code <code>         Code from the "CarePulse Bee link" card in the Alexa app (or BEE_LINK_CODE)
  --wearer-speaker <label>   Speaker label that is you; repeat if needed (or BEE_WEARER_SPEAKERS=a,b)
  --since-days <n>           Only data from the last n days (default 7)
  --max-conversations <n>    Conversation limit per run (default 50)
  --list-speakers            List speaker labels and counts, then exit
  --send                     Actually send to CarePulse
  --help                     Show this help

The MCP API key is read only from CAREPULSE_MCP_KEY, never from the command line.`;

const PROTOCOL_VERSION = '2025-11-25';
const LIST_KEYS = ['data', 'items', 'results'];
const TIME_FIELDS = ['start_time', 'started_at', 'startTime', 'created_at', 'createdAt', 'updated_at', 'updatedAt'];

function parseArgs(argv, env = process.env) {
    const options = {
        beeUrl: env.BEE_PROXY_URL,
        mcpUrl: env.CAREPULSE_MCP_URL,
        mcpKey: env.CAREPULSE_MCP_KEY,
        linkCode: env.BEE_LINK_CODE,
        wearerSpeakers: (env.BEE_WEARER_SPEAKERS || '').split(',').map(item => item.trim()).filter(Boolean),
        sinceDays: 7,
        maxConversations: 50,
        listSpeakers: false,
        send: false,
        help: false
    };
    const valueFlags = {
        '--bee-url': value => { options.beeUrl = value; },
        '--mcp-url': value => { options.mcpUrl = value; },
        '--link-code': value => { options.linkCode = value; },
        '--wearer-speaker': value => { options.wearerSpeakers.push(value); },
        '--since-days': value => { options.sinceDays = positiveNumber('--since-days', value); },
        '--max-conversations': value => { options.maxConversations = positiveNumber('--max-conversations', value); }
    };
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        if (flag === '--send') options.send = true;
        else if (flag === '--list-speakers') options.listSpeakers = true;
        else if (flag === '--help' || flag === '-h') options.help = true;
        else if (valueFlags[flag]) {
            const value = argv[++index];
            if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
            valueFlags[flag](value);
        } else {
            throw new Error(`Unknown option: ${flag}. Use --help.`);
        }
    }
    return options;
}

function positiveNumber(flag, value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number.`);
    return number;
}

function extractList(body, preferredKey) {
    if (Array.isArray(body)) return body;
    for (const key of [preferredKey, ...LIST_KEYS]) {
        if (Array.isArray(body?.[key])) return body[key];
    }
    throw new Error(`Unrecognized Bee response for ${preferredKey}. Run scripts/bee_schema_report.js on it and share the output.`);
}

function hasMorePages(body) {
    if (!body || Array.isArray(body)) return false;
    return Object.entries(body).some(([key, value]) => /cursor|next/i.test(key) && value);
}

function toIso(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value > 1e12 ? value : value * 1000).toISOString();
    }
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
        return new Date(value).toISOString();
    }
    return null;
}

function itemTime(item) {
    for (const field of TIME_FIELDS) {
        const iso = toIso(item?.[field]);
        if (iso) return iso;
    }
    return null;
}

function findUtterances(node, found = []) {
    if (Array.isArray(node)) {
        node.forEach(child => findUtterances(child, found));
    } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
            if (key === 'utterances' && Array.isArray(value)) found.push(...value);
            else findUtterances(value, found);
        }
    }
    return found;
}

function speakerLabel(utterance) {
    const speaker = utterance?.speaker ?? utterance?.speaker_id ?? utterance?.speakerId;
    return speaker === undefined || speaker === null ? '(none)' : String(speaker);
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

// One export per fact and per conversation, keyed by Bee's own timestamp, so
// re-running the bridge is skipped by CarePulse instead of duplicating events.
function buildExports({ facts, conversations, wearerSpeakers, sinceMs }) {
    const wearers = new Set(wearerSpeakers.map(String));
    const stats = {
        confirmedFacts: 0, unconfirmedFacts: 0, wearerUtterances: 0, otherUtterances: 0,
        conversationsUsed: 0, outsideWindow: 0, withoutTimestamp: 0
    };
    const exports = [];
    const inWindow = iso => Date.parse(iso) >= sinceMs;

    for (const fact of facts) {
        if (!isText(fact?.text)) continue;
        const exportedAt = itemTime(fact);
        if (!exportedAt) { stats.withoutTimestamp++; continue; }
        if (!inWindow(exportedAt)) { stats.outsideWindow++; continue; }
        if (fact.confirmed !== true) { stats.unconfirmedFacts++; continue; }
        stats.confirmedFacts++;
        exports.push({ kind: 'fact', beeExport: { exportedAt, facts: [{ text: fact.text, confirmed: true }] } });
    }

    for (const conversation of conversations) {
        const exportedAt = itemTime(conversation.summary) || itemTime(conversation.detail);
        if (!exportedAt) { stats.withoutTimestamp++; continue; }
        if (!inWindow(exportedAt)) { stats.outsideWindow++; continue; }
        const utterances = [];
        for (const utterance of findUtterances(conversation.detail)) {
            if (!isText(utterance?.text)) continue;
            if (wearers.has(speakerLabel(utterance))) {
                stats.wearerUtterances++;
                utterances.push({ speaker: 'wearer', text: utterance.text });
            } else {
                stats.otherUtterances++;
            }
        }
        if (!utterances.length) continue;
        stats.conversationsUsed++;
        exports.push({ kind: 'conversation', beeExport: { exportedAt, conversations: [{ utterances }] } });
    }
    return { exports, stats };
}

async function getJson(url, label) {
    let response;
    try {
        response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
        throw new Error(`Cannot reach the Bee proxy at ${url}. Start it with "bee proxy" in another terminal and use the URL it prints.`);
    }
    if (!response.ok) {
        throw new Error(`Bee proxy returned ${response.status} for ${label}. Is "bee proxy" running and are you logged in ("bee status")?`);
    }
    return response.json();
}

async function readBee(options, log) {
    const base = options.beeUrl.replace(/\/+$/, '');
    const factsBody = await getJson(`${base}/v1/facts`, '/v1/facts');
    if (hasMorePages(factsBody)) log('Note: Bee returned more pages of facts; only the first page is used.');
    const facts = extractList(factsBody, 'facts');

    const conversationsBody = await getJson(`${base}/v1/conversations`, '/v1/conversations');
    if (hasMorePages(conversationsBody)) log('Note: Bee returned more pages of conversations; only the first page is used.');
    const sinceMs = Date.now() - options.sinceDays * 24 * 60 * 60 * 1000;
    const recent = extractList(conversationsBody, 'conversations')
        .filter(item => {
            const iso = itemTime(item);
            return !iso || Date.parse(iso) >= sinceMs;
        })
        .slice(0, options.maxConversations);

    const conversations = [];
    for (const summary of recent) {
        if (summary?.id === undefined || summary?.id === null) continue;
        const detail = findUtterances(summary).length
            ? summary
            : await getJson(`${base}/v1/conversations/${encodeURIComponent(summary.id)}`, `/v1/conversations/${summary.id}`);
        conversations.push({ summary, detail });
    }
    return { facts, conversations, sinceMs };
}

function speakerCounts(conversations) {
    const counts = new Map();
    for (const conversation of conversations) {
        for (const utterance of findUtterances(conversation.detail)) {
            const label = speakerLabel(utterance);
            counts.set(label, (counts.get(label) || 0) + 1);
        }
    }
    return [...counts].sort((left, right) => right[1] - left[1]);
}

class McpClient {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.sessionId = null;
        this.nextId = 1;
    }

    async post(method, params) {
        const response = await fetch(this.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'x-carepulse-mcp-key': this.key,
                'mcp-protocol-version': PROTOCOL_VERSION,
                ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {})
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })
        }).catch(() => {
            throw new Error(`Cannot reach CarePulse at ${this.url}. Check --mcp-url (it must end in /mcp).`);
        });
        if (response.status === 401) throw new Error('CarePulse rejected the MCP key. Check CAREPULSE_MCP_KEY.');
        const body = await response.json();
        if (body.error) throw new Error(`CarePulse MCP error: ${body.error.message}`);
        return { body, response };
    }

    async open() {
        const { response } = await this.post('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'carepulse-bee-bridge', version: '1.0.0' }
        });
        this.sessionId = response.headers.get('mcp-session-id');
        if (!this.sessionId) throw new Error('CarePulse did not return an MCP session.');
    }

    async ingest(linkCode, beeExport) {
        const { body } = await this.post('tools/call', { name: 'ingest_bee_context', arguments: { linkCode, beeExport } });
        if (body.result?.isError) throw new Error(body.result.content?.[0]?.text || 'ingest_bee_context failed.');
        return body.result.structuredContent;
    }

    async close() {
        if (!this.sessionId) return;
        await fetch(this.url, {
            method: 'DELETE',
            headers: { 'x-carepulse-mcp-key': this.key, 'mcp-session-id': this.sessionId }
        }).catch(() => {});
    }
}

async function run(options, log = console.log) {
    if (options.help) { log(HELP); return null; }
    if (!options.beeUrl) throw new Error('Missing --bee-url (the URL printed by "bee proxy").');

    const bee = await readBee(options, log);
    if (options.listSpeakers) {
        const counts = speakerCounts(bee.conversations);
        log(counts.length ? 'Speaker labels in recent conversations (label: lines):' : 'No conversation lines found in recent conversations.');
        for (const [label, count] of counts) log(`  ${label}: ${count}`);
        log('Find which label is you, then pass it with --wearer-speaker <label>.');
        return { speakers: Object.fromEntries(counts) };
    }
    if (!options.wearerSpeakers.length) {
        log('No --wearer-speaker given: conversations are skipped so other people\'s words are never sent. Run with --list-speakers to find yours.');
    }

    const { exports, stats } = buildExports({ ...bee, wearerSpeakers: options.wearerSpeakers });
    log(`Facts: ${stats.confirmedFacts} confirmed to send, ${stats.unconfirmedFacts} unconfirmed not sent.`);
    log(`Conversations: ${stats.conversationsUsed} with your lines (${stats.wearerUtterances} lines); ${stats.otherUtterances} lines from others not sent.`);
    log(`Skipped: ${stats.outsideWindow} older than ${options.sinceDays} days, ${stats.withoutTimestamp} without a timestamp.`);

    if (!options.send) {
        log(`Dry run: ${exports.length} items would be sent. Add --send to send them.`);
        return { sent: false, items: exports.length, stats };
    }
    if (!exports.length) {
        log('Nothing to send.');
        return { sent: true, items: 0, eventsIngested: 0, skipped: 0, stats };
    }
    if (!options.mcpUrl) throw new Error('Missing --mcp-url (CarePulse MCP endpoint ending in /mcp).');
    if (!options.mcpKey) throw new Error('Missing CAREPULSE_MCP_KEY environment variable.');
    if (!options.linkCode) throw new Error('Missing --link-code. Say "Alexa, ask care pulse to link my Bee" and copy the code from the Alexa app card.');

    const client = new McpClient(options.mcpUrl, options.mcpKey);
    const totals = { eventsIngested: 0, skipped: 0, signals: new Set() };
    try {
        await client.open();
        for (const item of exports) {
            const result = await client.ingest(options.linkCode, item.beeExport);
            totals.eventsIngested += result.eventsIngested;
            totals.skipped += result.skipped;
            result.signalsDetected.forEach(signal => totals.signals.add(signal));
        }
    } finally {
        await client.close();
    }
    const signals = [...totals.signals];
    log(`Sent ${exports.length} items: ${totals.eventsIngested} new wellness signals, ${totals.skipped} already sent before.`);
    log(`Signals: ${signals.length ? signals.join(', ') : 'none detected'}.`);
    return { sent: true, items: exports.length, eventsIngested: totals.eventsIngested, skipped: totals.skipped, signals, stats };
}

module.exports = { parseArgs, extractList, toIso, findUtterances, buildExports, speakerCounts, run };

if (require.main === module) {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
    run(options).catch(error => {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    });
}

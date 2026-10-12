'use strict';

const { timingSafeEqual } = require('node:crypto');
const { MCP_TOOLS } = require('./mcp_tools');
const { callMcpTool } = require('./mcp_contracts');
const { createMcpSession, getMcpSession, deleteMcpSession } = require('./care_service');
const { updateRecord } = require('./care_repository');
const { metric, withRequest } = require('./observability');
const { InvalidBeeLinkError } = require('./bee_link');
const VERSIONS = ['2025-11-25', '2025-06-18'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function header(event, name) {
    const key = Object.keys(event.headers || {}).find(item => item.toLowerCase() === name);
    return typeof event.headers?.[key] === 'string' ? event.headers[key] : '';
}
function response(statusCode, body, headers = {}) {
    return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function authorized(event) {
    const expected = Buffer.from(process.env.MCP_API_KEY || '');
    const actual = Buffer.from(header(event, 'x-carepulse-mcp-key'));
    return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}
function validEnvelope(request) {
    return isObject(request) && request.jsonrpc === '2.0'
        && typeof request.method === 'string' && request.method.length > 0 && request.method.length <= 100
        && (request.params === undefined || isObject(request.params))
        && (request.id === undefined || typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)))
        && !('result' in request) && !('error' in request);
}

async function handle(event) {
    if (!authorized(event)) return response(401, rpcError(null, -32001, 'Unauthorized MCP request.'));
    const origin = header(event, 'origin');
    const origins = (process.env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (origin && !origins.includes(origin)) return response(403, rpcError(null, -32001, 'Origin is not allowed.'));
    const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
    if (!['POST', 'DELETE'].includes(method)) return response(405, undefined, { allow: 'POST, DELETE' });
    const sessionId = header(event, 'mcp-session-id');
    if (sessionId && !/^[a-f0-9-]{36}$/.test(sessionId)) return response(404, rpcError(null, -32000, 'Unknown or expired session.'));
    const suppliedVersion = header(event, 'mcp-protocol-version');
    if (suppliedVersion && !VERSIONS.includes(suppliedVersion)) return response(400, rpcError(null, -32602, 'Unsupported protocol version.'));

    if (method === 'DELETE') {
        const session = await getMcpSession(sessionId);
        if (!session) return response(404, rpcError(null, -32000, 'Unknown or expired session.'));
        if (suppliedVersion && suppliedVersion !== session.protocolVersion) return response(400, rpcError(null, -32602, 'Session protocol version mismatch.'));
        await deleteMcpSession(sessionId);
        return response(204);
    }
    if (header(event, 'content-type').toLowerCase().split(';')[0].trim() !== 'application/json') {
        return response(415, rpcError(null, -32600, 'Use application/json.'));
    }
    const accept = header(event, 'accept').toLowerCase().split(',').map(value => value.split(';')[0].trim());
    if (!(accept.includes('application/json') && accept.includes('text/event-stream')) && !accept.includes('*/*')) {
        return response(406, rpcError(null, -32600, 'Accept must include application/json and text/event-stream.'));
    }
    let request;
    try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
        if (typeof raw !== 'string') return response(400, rpcError(null, -32700, 'Parse error.'));
        if (Buffer.byteLength(raw) > 65536) return response(413, rpcError(null, -32600, 'Request is too large.'));
        request = JSON.parse(raw);
    } catch { return response(400, rpcError(null, -32700, 'Parse error.')); }
    if (!validEnvelope(request)) return response(400, rpcError(null, -32600, 'Invalid JSON-RPC request.'));
    const notification = request.id === undefined;
    if (notification !== request.method.startsWith('notifications/')) {
        return response(400, rpcError(request.id, -32600, 'Invalid request or notification identifier.'));
    }
    if (request.method === 'initialize') {
        const params = request.params;
        if (sessionId || !isObject(params) || typeof params.protocolVersion !== 'string'
            || !isObject(params.capabilities) || !isObject(params.clientInfo)
            || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
            return response(400, rpcError(request.id, -32602, 'Invalid initialization parameters.'));
        }
        const version = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
        const session = await createMcpSession({ protocolVersion: version });
        return response(200, rpcResult(request.id, {
            protocolVersion: version, capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'carepulse-mcp', version: '1.1.0' },
            instructions: 'Use only authorized test data. User-bound authorization remains required before a real-data deployment.'
        }), { 'mcp-session-id': session.sessionId, 'mcp-protocol-version': version });
    }
    const session = await getMcpSession(sessionId);
    if (!session) return response(404, rpcError(request.id, -32000, 'Unknown or expired session.'));
    const headers = { 'mcp-session-id': sessionId, 'mcp-protocol-version': session.protocolVersion };
    if (suppliedVersion && suppliedVersion !== session.protocolVersion) return response(400, rpcError(request.id, -32602, 'Session protocol version mismatch.'), headers);
    if (notification) {
        if (request.method === 'notifications/initialized') await updateRecord(session.pk, session.sk, { initialized: true });
        return response(202, undefined, headers);
    }
    if (request.method === 'ping') return response(200, rpcResult(request.id, {}), headers);
    if (!session.initialized) return response(400, rpcError(request.id, -32000, 'Session initialization is incomplete.'), headers);
    if (request.method === 'tools/list') return response(200, rpcResult(request.id, { tools: MCP_TOOLS }), headers);
    if (request.method === 'tools/call') {
        const name = request.params?.name;
        if (!MCP_TOOLS.some(tool => tool.name === name)) return response(200, rpcError(request.id, -32602, 'Unknown tool.'), headers);
        try {
            const result = await callMcpTool(name, request.params?.arguments);
            const failed = name === 'ingest_bee_context' && result.success === false;
            metric(failed ? 'ToolErrors' : 'ToolSuccesses');
            return response(200, rpcResult(request.id, {
                content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: failed
            }), headers);
        } catch (error) {
            metric('ToolErrors');
            return response(200, rpcResult(request.id, {
                content: [{ type: 'text', text: error instanceof InvalidBeeLinkError
                    ? new InvalidBeeLinkError().message
                    : error instanceof TypeError ? 'Invalid tool arguments.' : 'The tool could not complete the request.' }],
                isError: true
            }), headers);
        }
    }
    return response(200, rpcError(request.id, -32601, 'Method not found.'), headers);
}

exports.handler = (event, context) => withRequest('mcp', context, 12000, async () => {
    try {
        const result = await handle(event);
        if (result.statusCode >= 400) metric('HttpErrors');
        return result;
    } catch {
        metric('ServiceErrors');
        return response(500, rpcError(null, -32603, 'Internal service error.'));
    }
});

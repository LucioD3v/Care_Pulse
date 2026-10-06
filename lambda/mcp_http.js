'use strict';

const { timingSafeEqual } = require('node:crypto');
const {
    MCP_TOOLS,
    callTool,
    createMcpSession,
    getMcpSession,
    deleteMcpSession
} = require('./mcp_client');

const PROTOCOL_VERSION = '2025-11-25';

function response(statusCode, body, headers = {}) {
    return {
        statusCode,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'mcp-protocol-version': PROTOCOL_VERSION,
            ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    };
}

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code, message, ...(data === undefined ? {} : { data }) }
    };
}

function header(event, name) {
    const key = Object.keys(event.headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
    return key ? event.headers[key] : '';
}

function authorized(event) {
    const expected = process.env.MCP_API_KEY || '';
    const actual = header(event, 'x-carepulse-mcp-key');
    if (!expected || !actual) {
        return false;
    }
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseBody(event) {
    const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf8')
        : event.body;
    return JSON.parse(rawBody || '{}');
}

exports.handler = async function handler(event) {
    if (!authorized(event)) {
        return response(401, rpcError(null, -32001, 'Unauthorized MCP request.'));
    }

    const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
    const sessionId = header(event, 'mcp-session-id');
    if (method === 'DELETE') {
        if (sessionId) {
            await deleteMcpSession(sessionId);
        }
        return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
    }

    let request;
    try {
        request = parseBody(event);
    } catch (error) {
        return response(400, rpcError(null, -32700, 'Parse error.'));
    }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return response(400, rpcError(request.id, -32600, 'Invalid JSON-RPC request.'));
    }

    if (request.method === 'initialize') {
        const requestedVersion = request.params?.protocolVersion;
        if (requestedVersion !== PROTOCOL_VERSION) {
            return response(400, rpcError(request.id, -32602, `Unsupported protocol version: ${requestedVersion || 'missing'}.`));
        }
        const session = await createMcpSession({ clientInfo: request.params?.clientInfo || {} });
        return response(200, rpcResult(request.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'carepulse-mcp', version: '1.0.0' },
            instructions: 'Use CarePulse tools only with authorized demo data. Alerts require an active scoped consent record.'
        }), { 'mcp-session-id': session.sessionId });
    }

    const session = await getMcpSession(sessionId);
    if (!session) {
        return response(404, rpcError(request.id, -32000, 'Missing, expired, or unknown MCP session.'));
    }

    if (request.method === 'notifications/initialized') {
        return { statusCode: 202, headers: { 'cache-control': 'no-store', 'mcp-session-id': sessionId } };
    }
    if (request.method === 'ping') {
        return response(200, rpcResult(request.id, {}), { 'mcp-session-id': sessionId });
    }
    if (request.method === 'tools/list') {
        return response(200, rpcResult(request.id, { tools: MCP_TOOLS }), { 'mcp-session-id': sessionId });
    }
    if (request.method === 'tools/call') {
        const toolName = request.params?.name;
        if (!MCP_TOOLS.some(tool => tool.name === toolName)) {
            return response(200, rpcError(request.id, -32602, `Unknown tool: ${toolName || 'missing'}.`), { 'mcp-session-id': sessionId });
        }
        try {
            const result = await callTool(toolName, request.params?.arguments || {});
            console.info(JSON.stringify({ event: 'mcp_http_tool_completed', tool: toolName, sessionId }));
            return response(200, rpcResult(request.id, {
                content: [{ type: 'text', text: JSON.stringify(result) }],
                structuredContent: result,
                isError: false
            }), { 'mcp-session-id': sessionId });
        } catch (error) {
            console.warn('MCP tool call failed:', error.message);
            return response(200, rpcResult(request.id, {
                content: [{ type: 'text', text: error.message }],
                isError: true
            }), { 'mcp-session-id': sessionId });
        }
    }
    return response(200, rpcError(request.id, -32601, `Method not found: ${request.method}.`), { 'mcp-session-id': sessionId });
};

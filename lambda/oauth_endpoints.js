'use strict';

// Public OAuth discovery and a thin authorization-server facade for the Alexa+ MCP add-on.
// Cognito performs sign-in, PKCE verification, and token issuance. This facade exists because
// Cognito's discovery document omits code_challenge_methods_supported (Alexa+ blocks deployment
// without S256 there) and because Alexa+ sends the RFC 8707 `resource` parameter, which Cognito
// would turn into a token audience only with extra resource-binding setup.

const PRM_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
const AS_PATHS = new Set(['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']);
const MAX_TOKEN_BODY = 8192;

function json(statusCode, body) {
    return {
        statusCode,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify(body)
    };
}

function requestPath(event) {
    return event.rawPath || event.requestContext?.http?.path || event.path || '';
}

function requestMethod(event) {
    return event.requestContext?.http?.method || event.httpMethod || 'GET';
}

function header(event, name) {
    const key = Object.keys(event.headers || {}).find(item => item.toLowerCase() === name);
    return typeof event.headers?.[key] === 'string' ? event.headers[key] : '';
}

function baseUrl(event) {
    if (process.env.OAUTH_ISSUER_URL) return process.env.OAUTH_ISSUER_URL.replace(/\/+$/, '');
    const host = event.requestContext?.domainName || header(event, 'host');
    return host ? 'https://' + host : '';
}

function scopes() {
    return (process.env.MCP_OAUTH_SCOPES || 'carepulse/access').split(/[\s,]+/).filter(Boolean);
}

function cognitoUrl() {
    const url = (process.env.COGNITO_DOMAIN_URL || '').replace(/\/+$/, '');
    return /^https:\/\/[^/?#\s]+$/.test(url) ? url : '';
}

function isOAuthRoute(event) {
    const path = requestPath(event);
    return PRM_PATHS.has(path) || AS_PATHS.has(path) || path === '/oauth/authorize' || path === '/oauth/token';
}

function protectedResourceMetadata(event) {
    const base = baseUrl(event);
    return json(200, {
        // Must match the URL in the Alexa+ add-on manifest exactly.
        resource: process.env.MCP_RESOURCE_URL || base + '/mcp',
        authorization_servers: [base],
        scopes_supported: scopes(),
        bearer_methods_supported: ['header']
    });
}

function authorizationServerMetadata(event) {
    const base = baseUrl(event);
    const issuer = process.env.MCP_JWT_ISSUER;
    return json(200, {
        issuer: base,
        authorization_endpoint: base + '/oauth/authorize',
        token_endpoint: base + '/oauth/token',
        ...(issuer ? { jwks_uri: issuer.replace(/\/+$/, '') + '/.well-known/jwks.json' } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: scopes()
    });
}

function authorize(event) {
    const cognito = cognitoUrl();
    if (!cognito) return json(503, { error: 'temporarily_unavailable', error_description: 'Authorization server is not configured.' });
    const params = new URLSearchParams(event.rawQueryString || '');
    if (!event.rawQueryString && event.queryStringParameters) {
        for (const [key, value] of Object.entries(event.queryStringParameters)) params.set(key, value);
    }
    if (params.get('response_type') !== 'code' || !params.get('client_id') || !params.get('redirect_uri')) {
        return json(400, { error: 'invalid_request', error_description: 'response_type=code, client_id and redirect_uri are required.' });
    }
    if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(params.get('code_challenge') || '')) {
        return json(400, { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required.' });
    }
    params.delete('resource');
    // Redirects only to the fixed Cognito domain; Cognito validates the client and redirect URI.
    return { statusCode: 302, headers: { location: cognito + '/oauth2/authorize?' + params.toString(), 'cache-control': 'no-store' } };
}

async function token(event) {
    const cognito = cognitoUrl();
    if (!cognito) return json(503, { error: 'temporarily_unavailable', error_description: 'Authorization server is not configured.' });
    if (header(event, 'content-type').toLowerCase().split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
        return json(400, { error: 'invalid_request', error_description: 'Use application/x-www-form-urlencoded.' });
    }
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    if (Buffer.byteLength(raw) > MAX_TOKEN_BODY) return json(413, { error: 'invalid_request' });
    const form = new URLSearchParams(raw);
    if (!['authorization_code', 'refresh_token'].includes(form.get('grant_type'))) {
        return json(400, { error: 'unsupported_grant_type' });
    }
    form.delete('resource');
    const authorization = header(event, 'authorization');
    let upstream;
    try {
        upstream = await fetch(cognito + '/oauth2/token', {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
                ...(authorization ? { authorization } : {})
            },
            body: form.toString(),
            signal: AbortSignal.timeout(5000)
        });
    } catch {
        return json(502, { error: 'temporarily_unavailable', error_description: 'Authorization server did not respond.' });
    }
    return {
        statusCode: upstream.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' },
        body: await upstream.text()
    };
}

async function handleOAuth(event) {
    const path = requestPath(event);
    const method = requestMethod(event);
    if (PRM_PATHS.has(path)) return method === 'GET' ? protectedResourceMetadata(event) : json(405, { error: 'method_not_allowed' });
    if (AS_PATHS.has(path)) return method === 'GET' ? authorizationServerMetadata(event) : json(405, { error: 'method_not_allowed' });
    if (path === '/oauth/authorize') return method === 'GET' ? authorize(event) : json(405, { error: 'method_not_allowed' });
    if (path === '/oauth/token') return method === 'POST' ? token(event) : json(405, { error: 'method_not_allowed' });
    return json(404, { error: 'not_found' });
}

module.exports = { isOAuthRoute, handleOAuth };

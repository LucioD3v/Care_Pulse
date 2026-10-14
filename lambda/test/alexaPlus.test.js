'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { beforeEach, test } = require('node:test');
const YAML = require('yaml');
const { handler } = require('../mcp_http');
const identity = require('../identity_tokens');
const { resetMockRecords } = require('../care_repository');

const HOST = 'abc123.execute-api.us-east-1.amazonaws.com';
const COGNITO = 'https://carepulse-dev-123.auth.us-east-1.amazoncognito.com';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

beforeEach(() => {
    for (const name of ['MCP_API_KEY', 'MCP_RESOURCE_URL', 'OAUTH_ISSUER_URL', 'MCP_JWT_ISSUER', 'MCP_JWT_AUDIENCE',
        'MCP_JWT_CLIENT_IDS', 'MCP_JWKS_URI', 'MCP_OAUTH_SCOPES']) delete process.env[name];
    process.env.COGNITO_DOMAIN_URL = COGNITO;
    process.env.DEMO_OWNER_ID = 'alexa-plus-demo-owner';
    resetMockRecords();
});

function get(rawPath, rawQueryString = '') {
    return handler({ rawPath, rawQueryString, headers: { host: HOST }, requestContext: { domainName: HOST, http: { method: 'GET', path: rawPath } } }, {});
}

function rpc(body, headers = {}) {
    return handler({
        rawPath: '/mcp',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        requestContext: { domainName: HOST, http: { method: 'POST', path: '/mcp' } },
        body: JSON.stringify({ jsonrpc: '2.0', ...body })
    }, {});
}

async function openSession(headers) {
    const init = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'alexa-plus', version: '1' } } }, headers);
    assert.equal(init.statusCode, 200);
    const sessionHeaders = { ...headers, 'mcp-session-id': init.headers['mcp-session-id'] };
    assert.equal((await rpc({ method: 'notifications/initialized' }, sessionHeaders)).statusCode, 202);
    return sessionHeaders;
}

// --- Discovery ---

test('protected resource metadata points Alexa+ to the CarePulse authorization server without authentication', async () => {
    for (const route of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
        const result = await get(route);
        assert.equal(result.statusCode, 200);
        assert.deepEqual(JSON.parse(result.body), {
            resource: `https://${HOST}/mcp`,
            authorization_servers: [`https://${HOST}`],
            scopes_supported: ['carepulse/access'],
            bearer_methods_supported: ['header']
        });
    }
    process.env.MCP_RESOURCE_URL = 'https://care.example/mcp';
    assert.equal(JSON.parse((await get('/.well-known/oauth-protected-resource')).body).resource, 'https://care.example/mcp');
});

test('authorization server metadata advertises S256 PKCE, which Cognito discovery omits', async () => {
    process.env.MCP_JWT_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
    for (const route of ['/.well-known/oauth-authorization-server']) {
        const metadata = JSON.parse((await get(route)).body);
        assert.equal(metadata.issuer, `https://${HOST}`);
        assert.equal(metadata.authorization_endpoint, `https://${HOST}/oauth/authorize`);
        assert.equal(metadata.token_endpoint, `https://${HOST}/oauth/token`);
        assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
        assert.deepEqual(metadata.grant_types_supported, ['authorization_code', 'refresh_token']);
        assert.equal(metadata.jwks_uri, 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool/.well-known/jwks.json');
    }
    // CarePulse is not an OpenID provider, so it publishes no OIDC discovery document.
    assert.notEqual((await get('/.well-known/openid-configuration')).statusCode, 200);
});

// --- Authorization facade ---

test('authorize redirects to Cognito with PKCE intact and the resource parameter removed', async () => {
    const query = new URLSearchParams({
        response_type: 'code', client_id: 'client-1', redirect_uri: 'https://alexa.example/redirect',
        scope: 'carepulse/access', state: 'xyz', code_challenge: CHALLENGE, code_challenge_method: 'S256',
        resource: `https://${HOST}/mcp`
    }).toString();
    const result = await get('/oauth/authorize', query);
    assert.equal(result.statusCode, 302);
    const location = new URL(result.headers.location);
    assert.equal(location.origin + location.pathname, COGNITO + '/oauth2/authorize');
    assert.equal(location.searchParams.get('code_challenge'), CHALLENGE);
    assert.equal(location.searchParams.get('state'), 'xyz');
    assert.equal(location.searchParams.get('redirect_uri'), 'https://alexa.example/redirect');
    assert.equal(location.searchParams.has('resource'), false);
});

test('authorize refuses requests without S256 PKCE and when Cognito is not configured', async () => {
    const base = { response_type: 'code', client_id: 'c', redirect_uri: 'https://alexa.example/r' };
    assert.equal((await get('/oauth/authorize', new URLSearchParams(base).toString())).statusCode, 400);
    assert.equal((await get('/oauth/authorize', new URLSearchParams({ ...base, code_challenge: CHALLENGE, code_challenge_method: 'plain' }).toString())).statusCode, 400);
    delete process.env.COGNITO_DOMAIN_URL;
    assert.equal((await get('/oauth/authorize', new URLSearchParams({ ...base, code_challenge: CHALLENGE, code_challenge_method: 'S256' }).toString())).statusCode, 503);
});

test('token requests are forwarded to Cognito with client credentials and without resource', async t => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    });
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://alexa.example/r',
        client_id: 'client-1', code_verifier: 'v'.repeat(43), resource: `https://${HOST}/mcp` }).toString();
    const result = await handler({
        rawPath: '/oauth/token', isBase64Encoded: true, body: Buffer.from(body).toString('base64'),
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic Y2xpZW50LTE6c2VjcmV0' },
        requestContext: { domainName: HOST, http: { method: 'POST', path: '/oauth/token' } }
    }, {});
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).refresh_token, 'r');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(calls[0].url, COGNITO + '/oauth2/token');
    assert.equal(calls[0].init.headers.authorization, 'Basic Y2xpZW50LTE6c2VjcmV0');
    const forwarded = new URLSearchParams(calls[0].init.body);
    assert.equal(forwarded.get('code_verifier'), 'v'.repeat(43));
    assert.equal(forwarded.has('resource'), false);
});

test('token endpoint rejects unsupported grants and content types, and reports an unreachable Cognito', async t => {
    const post = (body, type = 'application/x-www-form-urlencoded') => handler({
        rawPath: '/oauth/token', body, headers: { 'content-type': type },
        requestContext: { domainName: HOST, http: { method: 'POST', path: '/oauth/token' } }
    }, {});
    assert.equal((await post('grant_type=client_credentials')).statusCode, 400);
    assert.equal((await post('{}', 'application/json')).statusCode, 400);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('network'); });
    assert.equal((await post('grant_type=refresh_token&refresh_token=r')).statusCode, 502);
});

// --- Token verification for Cognito access tokens ---

test('Cognito access tokens without aud are accepted only for an allowed client_id', async t => {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const jwk = { ...await jose.exportJWK(publicKey), kid: 'k', alg: 'RS256', use: 'sig' };
    process.env.MCP_JWT_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool';
    process.env.MCP_JWKS_URI = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool/.well-known/jwks.json';
    process.env.MCP_JWT_CLIENT_IDS = 'alexa-client';
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sign = changes => new jose.SignJWT({
        sub: 'u', iss: process.env.MCP_JWT_ISSUER, client_id: 'alexa-client', token_use: 'access', scope: 'carepulse/access',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...changes
    }).setProtectedHeader({ alg: 'RS256', kid: 'k' }).sign(privateKey);
    assert.equal((await identity.verifyToken(await sign({}))).sub, 'u');
    await assert.rejects(identity.verifyToken(await sign({ client_id: 'another-client' })));
    await assert.rejects(identity.verifyToken(await sign({ aud: 'some-other-api' })));
});

// --- MCP access with an OAuth token (demo mode) ---

test('a verified Bearer token opens the MCP without the shared key and cannot pick another owner', async t => {
    process.env.MCP_API_KEY = 'shared-demo-key';
    t.mock.method(identity, 'verifyToken', async token => {
        if (token !== 'good-token') throw new Error('bad token');
        return { sub: 'alexa-user', iss: 'https://issuer.example' };
    });
    const session = await openSession({ authorization: 'Bearer good-token' });

    const list = JSON.parse((await rpc({ id: 2, method: 'tools/list', params: {} }, session)).body);
    const context = list.result.tools.find(tool => tool.name === 'get_care_context');
    assert.equal('ownerId' in context.inputSchema.properties, false);
    assert.equal(context.inputSchema.required.includes('ownerId'), false);

    const call = async args => JSON.parse((await rpc({ id: 3, method: 'tools/call', params: { name: 'get_care_context', arguments: args } }, session)).body).result;
    assert.equal((await call({ memberName: 'Elena' })).isError, false);
    assert.equal((await call({ memberName: 'Elena', ownerId: 'someone-else' })).isError, true);
});

test('missing or invalid tokens get a plain 401 so Alexa+ starts account linking', async t => {
    process.env.MCP_API_KEY = 'shared-demo-key';
    t.mock.method(identity, 'verifyToken', async () => { throw new Error('expired'); });
    for (const headers of [{}, { authorization: 'Bearer expired-token' }]) {
        const result = await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'a', version: '1' } } }, headers);
        assert.equal(result.statusCode, 401);
        assert.equal(Object.keys(result.headers).some(name => name.toLowerCase() === 'www-authenticate'), false);
    }
    // The shared-key demo client keeps working.
    await openSession({ 'x-carepulse-mcp-key': 'shared-demo-key' });
});

// --- Infrastructure ---

test('Serverless defines a Cognito authorization-code client with PKCE routes for Alexa+', () => {
    const config = YAML.parse(fs.readFileSync(path.join(__dirname, '../../serverless.yml'), 'utf8'));
    const resources = config.resources.Resources;
    const client = resources.McpAlexaClient.Properties;
    assert.deepEqual(client.AllowedOAuthFlows, ['code']);
    assert.equal(client.GenerateSecret, true);
    assert.deepEqual(client.AllowedOAuthScopes, ['carepulse/access']);
    assert.equal(resources.McpResourceServer.Properties.Identifier, 'carepulse');
    assert.equal(resources.McpUserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly, true);
    const routes = config.functions.mcpGateway.events.map(event => `${event.httpApi.method} ${event.httpApi.path}`);
    for (const route of ['GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-authorization-server',
        'GET /oauth/authorize', 'POST /oauth/token']) assert.ok(routes.includes(route), route);
    assert.equal(routes.includes('GET /.well-known/openid-configuration'), false);
    const env = config.functions.mcpGateway.environment;
    assert.deepEqual(env.MCP_JWT_CLIENT_IDS, { Ref: 'McpAlexaClient' });
    assert.equal(env.MCP_OAUTH_SCOPES, 'carepulse/access');
});

// --- Consent cannot be created by a model over OAuth ---

test('Alexa+ OAuth callers cannot see or call consent or alert tools; the shared-key client is unchanged', async t => {
    process.env.MCP_API_KEY = 'shared-demo-key';
    t.mock.method(identity, 'verifyToken', async () => ({ sub: 'alexa-user', iss: 'https://issuer.example' }));
    const tokenSession = await openSession({ authorization: 'Bearer good-token' });
    const tokenTools = JSON.parse((await rpc({ id: 2, method: 'tools/list', params: {} }, tokenSession)).body).result.tools.map(tool => tool.name);
    assert.equal(tokenTools.includes('request_consent'), false);
    assert.equal(tokenTools.includes('send_caregiver_alert'), false);
    assert.ok(tokenTools.includes('complete_followup'));

    const care = require('../care_service');
    const today = new Date().toISOString().slice(0, 10);
    const followup = await care.createFollowup({ ownerId: 'alexa-plus-demo-owner', memberName: 'Elena', signal: 'tiredness', dueDate: today, dueTime: '18:00' });
    const attempt = JSON.parse((await rpc({ id: 3, method: 'tools/call', params: { name: 'request_consent', arguments: {
        memberName: 'Elena', caregiverName: 'Laura', signal: 'tiredness', followupId: followup.followupId
    } } }, tokenSession)).body).result;
    assert.equal(attempt.isError, true);
    assert.equal(await care.findActiveConsent({ ownerId: 'alexa-plus-demo-owner', memberName: 'Elena', caregiverName: 'Laura',
        signal: 'tiredness', followupId: followup.followupId }), null);

    const alert = JSON.parse((await rpc({ id: 5, method: 'tools/call', params: { name: 'send_caregiver_alert', arguments: {
        memberName: 'Elena', caregiverName: 'Laura', signal: 'tiredness', followupStatus: 'same', consentId: 'any', authorized: true
    } } }, tokenSession)).body).result;
    assert.equal(alert.isError, true);

    const keySession = await openSession({ 'x-carepulse-mcp-key': 'shared-demo-key' });
    const keyTools = JSON.parse((await rpc({ id: 4, method: 'tools/list', params: {} }, keySession)).body).result.tools.map(tool => tool.name);
    assert.ok(keyTools.includes('request_consent'));
    assert.ok(keyTools.includes('send_caregiver_alert'));
});

test('with voice consent in place, an Alexa+ token caller still cannot send the caregiver alert', async t => {
    // The real risk: the person consented by voice, then the model completes the check-in and alerts.
    process.env.MCP_API_KEY = 'shared-demo-key';
    t.mock.method(identity, 'verifyToken', async () => ({ sub: 'alexa-user', iss: 'https://issuer.example' }));
    const { handler: alexaHandler } = require('../index');
    const access = require('../access_control');
    const care = require('../care_service');
    const voice = (intentName, extra = {}) => new Promise((resolve, reject) => alexaHandler({
        version: '1.0',
        session: { new: false, sessionId: 's', application: { applicationId: 'test' }, user: { userId: 'voice-user' }, attributes: extra.attributes || {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId: 'voice-user' }, device: { deviceId: 'd', supportedInterfaces: {} } } },
        request: { type: 'IntentRequest', requestId: 'r-' + Date.now(), timestamp: new Date().toISOString(), locale: 'en-US',
            intent: { name: intentName, confirmationStatus: 'NONE', slots: extra.slots || {} } }
    }, {}, (error, result) => error ? reject(error) : resolve(result)));

    const report = await voice('ReportWellnessIntent', { slots: { wellnessSignal: { name: 'wellnessSignal', value: 'tiredness' }, intensity: { name: 'intensity', value: 'more than usual' } } });
    const schedule = await voice('AMAZON.YesIntent', { attributes: report.sessionAttributes });
    await voice('AMAZON.YesIntent', { attributes: schedule.sessionAttributes });
    const owner = { ownerId: 'alexa-plus-demo-owner', memberName: 'Elena' };
    const followup = await care.getPendingFollowup(owner);
    const consent = await care.findActiveConsent({ ...owner, caregiverName: 'Laura', signal: 'tiredness', followupId: followup.followupId });
    assert.ok(consent, 'voice consent exists');

    const session = await openSession({ authorization: 'Bearer good-token' });
    const call = async (name, args) => JSON.parse((await rpc({ id: 9, method: 'tools/call', params: { name, arguments: args } }, session)).body).result;
    assert.equal((await call('complete_followup', { memberName: 'Elena', followupId: followup.followupId, status: 'same' })).isError, false);
    const alertInput = { memberName: 'Elena', caregiverName: 'Laura', signal: 'tiredness', followupStatus: 'same', consentId: consent.consentId };
    assert.equal((await call('send_caregiver_alert', alertInput)).isError, true);

    // Everything else was in order: the same alert succeeds for the shared-key demo client.
    const sent = await access.withPrincipal({ ownerId: owner.ownerId, channel: 'mcp', demo: true },
        () => care.sendCaregiverAlert({ ...alertInput, ownerId: owner.ownerId }));
    assert.equal(sent.simulated, true);
});

test('production MCP principals keep the token marker so consent stays hidden there too', async t => {
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    const access = require('../access_control');
    process.env.CARE_MODE = 'production';
    process.env.CARE_TABLE_NAME = 'test';
    t.after(() => { process.env.CARE_MODE = 'demo'; delete process.env.CARE_TABLE_NAME; });
    t.mock.method(identity, 'verifyToken', async () => ({ iss: 'https://issuer.example', sub: 'user' }));
    t.mock.method(DynamoDBDocumentClient.prototype, 'send', async command => ({ Item:
        command.input.Key.sk === 'BINDING' ? { status: 'active', ownerId: 'a' }
            : { status: 'active', members: [{ memberId: 'm', name: 'Elena', status: 'active', storageConsentGranted: true, role: 'owner' }] }
    }));
    const principal = await access.fromMcp({ headers: { Authorization: 'Bearer token' } });
    assert.equal(principal.ownerId, 'a');
    assert.equal(principal.viaToken, true);
});

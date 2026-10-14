'use strict';

let keySet, keySetUrl;
async function verifyToken(token) {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    const issuer = process.env.MCP_JWT_ISSUER;
    const audience = (process.env.MCP_JWT_AUDIENCE || '').split(',').filter(Boolean);
    const clientIds = (process.env.MCP_JWT_CLIENT_IDS || '').split(',').filter(Boolean);
    const url = new URL(process.env.MCP_JWKS_URI || 'https://invalid.invalid');
    if (!issuer?.startsWith('https://') || !(audience.length || clientIds.length) || !process.env.MCP_JWKS_URI
        || url.protocol !== 'https:' || url.username || url.password) throw new Error('Identity provider is not configured.');
    if (keySetUrl !== url.href) {
        keySetUrl = url.href;
        keySet = createRemoteJWKSet(url, { timeoutDuration: 1500, cooldownDuration: 30000, cacheMaxAge: 600000 });
    }
    const { payload } = await jwtVerify(token, keySet, {
        issuer, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
        clockTolerance: 5
    });
    // Cognito access tokens carry client_id instead of aud unless resource binding is used.
    const audiences = payload.aud === undefined ? [] : [].concat(payload.aud);
    const audienceOk = audiences.length ? audiences.some(value => audience.includes(value))
        : clientIds.includes(payload.client_id);
    if (!audienceOk) throw new Error('The token was not issued for CarePulse.');
    if (payload.token_use !== 'access' || !String(payload.scope || '').split(' ').includes('carepulse/access')) {
        throw new Error('A scoped access token is required.');
    }
    return payload;
}

module.exports = { verifyToken };

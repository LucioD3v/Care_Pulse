'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { getRecord, partitionKey } = require('./care_repository');
const { isDemo } = require('./runtime_config');
const principals = new AsyncLocalStorage();
const digest = value => createHash('sha256').update(value).digest('hex');

class AccessError extends Error {
    constructor() { super('This account is not authorized for that operation. Complete secure profile setup first.'); this.name = 'AccessError'; }
}

function currentPrincipal() { return principals.getStore(); }
function withPrincipal(principal, action) { return principals.run(principal, action); }

async function principalForOwner(ownerId, requestId, channel) {
    if (!ownerId) throw new AccessError();
    if (isDemo()) return { ownerId, requestId, channel, demo: true };
    const profile = await getRecord(partitionKey(ownerId), 'ACCESS#PROFILE');
    if (!profile || profile.status !== 'active' || !Array.isArray(profile.members)) throw new AccessError();
    return { ownerId, requestId, channel, profile };
}

async function fromAlexa(event) {
    const userId = event.context?.System?.user?.userId || event.session?.user?.userId;
    if (typeof userId !== 'string' || !userId) throw new AccessError();
    if (process.env.DEMO_OWNER_ID && !isDemo()) throw new AccessError();
    const ownerId = isDemo() && process.env.DEMO_OWNER_ID
        ? process.env.DEMO_OWNER_ID : digest(userId).slice(0, 32);
    return principalForOwner(ownerId, event.request?.requestId, 'alexa');
}

async function verifiedClaims(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new AccessError();
    let claims;
    try { claims = await require('./identity_tokens').verifyToken(header.slice(7)); }
    catch { throw new AccessError(); }
    if (typeof claims.sub !== 'string' || !claims.sub) throw new AccessError();
    return claims;
}

async function fromMcp(event) {
    const header = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    if (isDemo()) {
        if (header === undefined) return { ownerId: process.env.DEMO_OWNER_ID || null, channel: 'mcp', demo: true };
        // Alexa+ authenticates with OAuth. In demo mode only the single configured Cognito subject may
        // act for the demo owner, so a second account can never reach the same wellness records.
        const claims = await verifiedClaims(header);
        const subject = process.env.DEMO_TOKEN_SUBJECT;
        if (!process.env.DEMO_OWNER_ID || !subject || claims.sub !== subject) throw new AccessError();
        return { ownerId: process.env.DEMO_OWNER_ID, channel: 'mcp', demo: true, viaToken: true };
    }
    const claims = await verifiedClaims(header);
    const binding = await getRecord('IDENTITY#' + digest(claims.iss + '|' + claims.sub), 'BINDING');
    if (!binding || binding.status !== 'active') throw new AccessError();
    return { ...await principalForOwner(binding.ownerId, event.requestContext?.requestId, 'mcp'), viaToken: true };
}

function authorizeMember(ownerId, memberName, write = false) {
    if (isDemo()) {
        const principal = currentPrincipal();
        if (principal?.ownerId && principal.ownerId !== ownerId) throw new AccessError();
        return null;
    }
    const principal = currentPrincipal();
    const member = principal?.profile?.members.find(item => item.name === memberName && item.status === 'active');
    if (!principal || principal.ownerId !== ownerId || !member?.memberId
        || !member.storageConsentGranted || (write && member.role !== 'owner')) throw new AccessError();
    return member;
}

function defaultMember() {
    if (isDemo()) return process.env.DEFAULT_MEMBER_NAME || 'Elena';
    const profile = currentPrincipal()?.profile;
    const member = profile?.members.find(item => item.memberId === profile.defaultMemberId && item.status === 'active');
    if (!member) throw new AccessError();
    return member.name;
}

module.exports = { AccessError, currentPrincipal, withPrincipal, fromAlexa, fromMcp, authorizeMember, defaultMember, principalForOwner, digest };

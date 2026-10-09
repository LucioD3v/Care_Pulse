'use strict';

const { createHash, randomInt, randomUUID } = require('node:crypto');
const {
    partitionKey,
    putRecord,
    getRecord,
    deleteRecord,
    updateRecord,
    queryAllPrefix
} = require('./care_repository');

const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LINK_CODE_LENGTH = 8;
const BEE_CONSENT_SCOPE = 'derive-wellness-signals-from-wearer-speech-and-confirmed-facts';

function memberKey(memberName) {
    return String(memberName || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function consentDays() {
    const days = Number(process.env.BEE_CONSENT_DAYS || 30);
    return Number.isFinite(days) && days > 0 ? days : 30;
}

function normalizeLinkCode(linkCode) {
    return String(linkCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function linkHash(linkCode) {
    return createHash('sha256').update(normalizeLinkCode(linkCode)).digest('hex');
}

function generateLinkCode() {
    const characters = Array.from({ length: LINK_CODE_LENGTH }, () => LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)]);
    return `${characters.slice(0, 4).join('')}-${characters.slice(4).join('')}`;
}

function consentSortKey(memberName) {
    return `BEECONSENT#${memberKey(memberName)}`;
}

async function getBeeConsent({ ownerId, memberName }) {
    const consent = await getRecord(partitionKey(ownerId), consentSortKey(memberName));
    const now = Math.floor(Date.now() / 1000);
    return consent && consent.status === 'active' && consent.expiresAt > now ? consent : null;
}

async function deleteBeeEvents({ ownerId, memberName }) {
    const pk = partitionKey(ownerId);
    const events = await queryAllPrefix(pk, `EVENT#${memberKey(memberName)}#`);
    const beeEvents = events.filter(event => event.provenance === 'bee');
    for (const event of beeEvents) {
        await deleteRecord(pk, event.sk);
    }
    return beeEvents.length;
}

async function grantBeeConsent({ ownerId, memberName }) {
    const pk = partitionKey(ownerId);
    const previous = await getRecord(pk, consentSortKey(memberName));
    if (previous?.linkHash) {
        await deleteRecord(`BEELINK#${previous.linkHash}`, 'LINK');
    }
    const linkCode = generateLinkCode();
    const hash = linkHash(linkCode);
    const consentId = randomUUID();
    const grantedAt = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + consentDays() * 24 * 60 * 60;
    await putRecord({
        pk,
        sk: consentSortKey(memberName),
        entityType: 'BEE_CONSENT',
        consentId,
        memberName,
        scope: BEE_CONSENT_SCOPE,
        status: 'active',
        linkHash: hash,
        grantedAt,
        expiresAt
    });
    await putRecord({
        pk: `BEELINK#${hash}`,
        sk: 'LINK',
        entityType: 'BEE_LINK',
        ownerId,
        memberName,
        consentId,
        expiresAt
    });
    return { linkCode, consentId, expiresAt };
}

async function resolveBeeLink(linkCode) {
    const invalid = new Error('Bee link code is invalid, expired, or revoked. Ask the member to link Bee again in CarePulse.');
    if (normalizeLinkCode(linkCode).length !== LINK_CODE_LENGTH) {
        throw invalid;
    }
    const hash = linkHash(linkCode);
    const link = await getRecord(`BEELINK#${hash}`, 'LINK');
    if (!link) {
        throw invalid;
    }
    const consent = await getBeeConsent({ ownerId: link.ownerId, memberName: link.memberName });
    if (!consent || consent.linkHash !== hash || consent.consentId !== link.consentId) {
        throw invalid;
    }
    return { ownerId: link.ownerId, memberName: link.memberName, consentId: consent.consentId };
}

async function revokeBeeConsent({ ownerId, memberName }) {
    const pk = partitionKey(ownerId);
    const consent = await getRecord(pk, consentSortKey(memberName));
    const wasActive = consent?.status === 'active';
    if (consent?.linkHash) {
        await deleteRecord(`BEELINK#${consent.linkHash}`, 'LINK');
    }
    if (wasActive) {
        await updateRecord(pk, consent.sk, { status: 'revoked', revokedAt: new Date().toISOString(), linkHash: null });
    }
    const eventsDeleted = await deleteBeeEvents({ ownerId, memberName });
    return { revoked: wasActive, eventsDeleted };
}

module.exports = {
    BEE_CONSENT_SCOPE,
    grantBeeConsent,
    resolveBeeLink,
    revokeBeeConsent,
    getBeeConsent,
    normalizeLinkCode,
    consentDays
};

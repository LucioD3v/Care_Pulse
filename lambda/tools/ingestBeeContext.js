'use strict';

const { partitionKey, putRecordIfAbsent } = require('../care_repository');
const { getCareContext } = require('../care_service');
const { resolveBeeLink } = require('../bee_link');
const { sleepIntensity, verifiedSleepBaseline } = require('../care_baseline');
const { metric } = require('../observability');
const { createHash } = require('node:crypto');

const { retentionSeconds } = require('../runtime_config');

const SIGNAL_PATTERNS = [
    { pattern: /\b(tired|exhausted|drained)\b/i, signal: 'tiredness' },
    { pattern: /\binsomnia\b|\bslept badly\b/i, signal: 'sleep' },
    { pattern: /\b(sad|anxious|stressed)\b/i, signal: 'mood' },
    { pattern: /\bnot hungry\b|\bno appetite\b/i, signal: 'appetite' },
    { pattern: /\bdizzy\b/i, signal: 'dizziness' },
    { pattern: /\b(pain|ache|aches|aching)\b/i, signal: 'discomfort' }
];

const HIGH_INTENSITY = /\b(extremely|completely|totally)\b/i;
const MODERATE_INTENSITY = /\b(very|really|quite)\b/i;

function detectIntensity(text, pattern) {
    const match = pattern.exec(text);
    const preceding = match ? text.slice(0, match.index).trimEnd() : '';
    if (HIGH_INTENSITY.test(preceding.split(/\s+/).at(-1) || '')) return 'high';
    if (MODERATE_INTENSITY.test(preceding.split(/\s+/).at(-1) || '')) return 'moderate';
    return 'reported';
}

function extractSignalsFromText(texts, memberName = '') {
    const seen = new Set();
    const results = [];
    for (const text of texts) {
        for (const clause of text.split(/[.!?;,]|\bbut\b/i)) {
            const trimmed = clause.trim();
            if (!trimmed) continue;
            const otherPerson = /\b(my|our|his|her|their)\s+(mother|father|mom|dad|brother|sister|friend|partner|child|daughter|son)\b|\b(he|she|they|someone else)\b/i;
            if (otherPerson.test(trimmed) && !(memberName && trimmed.toLowerCase().includes(memberName.toLowerCase()))) continue;
            for (const { pattern, signal } of SIGNAL_PATTERNS) {
                if (seen.has(signal) || !pattern.test(trimmed)) continue;
                if (signal !== 'appetite' && /\b(?:not|never|no longer|without)\s+(?:(?:feeling|being|very|really|any)\s+){0,2}(?:tired|exhausted|drained|sad|anxious|stressed|dizzy|in pain|pain|aching|aches|insomnia)\b/i.test(trimmed)) continue;
                seen.add(signal);
                results.push({ signal, intensity: detectIntensity(trimmed, pattern), source: 'bee' });
            }
        }
    }
    return results;
}

function memberKey(memberName) {
    return String(memberName).trim().toLowerCase().replace(/\s+/g, '-');
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateExport(beeExport) {
    if (!beeExport || typeof beeExport !== 'object') {
        throw new TypeError('beeExport is required.');
    }
    // Source identity and timestamp distinguish exports; replaying the same export is idempotent.
    if (typeof beeExport.exportedAt !== 'string' || Number.isNaN(Date.parse(beeExport.exportedAt))) {
        throw new TypeError('beeExport.exportedAt must be an ISO 8601 date-time.');
    }
    for (const field of ['facts', 'conversations']) {
        if (beeExport[field] !== undefined && !Array.isArray(beeExport[field])) {
            throw new TypeError(`beeExport.${field} must be an array.`);
        }
    }
    const sleepHours = beeExport.healthKit?.sleepHours;
    if (sleepHours !== undefined && (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 24)) {
        throw new TypeError('beeExport.healthKit.sleepHours must be a number between 0 and 24.');
    }
}

// Only the wearer's own words and facts they confirmed are analyzed; Bee also records bystanders.
function selectWearerTexts(beeExport) {
    const ignored = { unconfirmedFacts: 0, otherSpeakerUtterances: 0 };
    const texts = [];
    for (const fact of beeExport.facts || []) {
        if (!isText(fact?.text)) continue;
        if (fact.confirmed === true) {
            texts.push(fact.text);
        } else {
            ignored.unconfirmedFacts++;
        }
    }
    for (const conversation of beeExport.conversations || []) {
        for (const utterance of conversation?.utterances || []) {
            if (!isText(utterance?.text)) continue;
            if (utterance.speaker === 'wearer') {
                texts.push(utterance.text);
            } else {
                ignored.otherSpeakerUtterances++;
            }
        }
    }
    return { texts, ignored };
}

async function ingestBeeContext({ linkCode, beeExport } = {}) {
    const { ownerId, memberName, consentId, consentCheck } = await resolveBeeLink(linkCode);
    validateExport(beeExport);
    require('../mcp_contracts').validateToolInput('ingest_bee_context', { linkCode, beeExport });
    const startedAt = Date.now();
    const pk = partitionKey(ownerId);
    const recordedAt = new Date(beeExport.exportedAt).toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + retentionSeconds();
    const sourceKey = beeExport.sourceId
        ? createHash('sha256').update(beeExport.sourceId).digest('hex')
        : createHash('sha256').update(JSON.stringify(beeExport)).digest('hex');
    const eventPrefix = `EVENT#${memberKey(memberName)}#${recordedAt}#${sourceKey}`;
    const { texts, ignored } = selectWearerTexts(beeExport);

    const events = extractSignalsFromText(texts, memberName).map(({ signal, intensity }) => ({
        sk: `${eventPrefix}#bee-text-${signal}`,
        signal,
        state: intensity,
        details: 'Detected in the wearer\'s own Bee context'
    }));

    const sleepHours = beeExport.healthKit?.sleepHours;
    if (sleepHours !== undefined) {
        const context = await getCareContext({ ownerId, memberName });
        const baseline = verifiedSleepBaseline(context);
        events.push({
            sk: `${eventPrefix}#bee-healthkit-sleep`,
            signal: 'sleep',
            state: baseline === null ? 'reported' : sleepIntensity(sleepHours, baseline),
            numericValue: sleepHours,
            details: baseline === null ? `${sleepHours} hours from Bee export; no verified baseline`
                : `${sleepHours} hours from Bee export (baseline ${baseline} hours)`
        });
    }

    let eventsIngested = 0;
    let skipped = 0;
    const errors = [];
    for (const event of events) {
        try {
            const written = await putRecordIfAbsent({
                pk,
                ...event,
                entityType: 'WELLNESS_EVENT',
                memberName,
                recordedAt,
                provenance: 'bee',
                source: 'bee',
                beeConsentId: consentId,
                expiresAt
            }, { checks: [consentCheck] });
            written ? eventsIngested++ : skipped++;
        } catch {
            errors.push({ signal: event.signal, message: 'The event could not be saved. Its write status is unconfirmed.' });
        }
    }

    const signalsDetected = [...new Set(events.map(event => event.signal))];
    metric('BeeIngestionDuration', Date.now() - startedAt, 'Milliseconds');
    metric('BeeEventsIngested', eventsIngested);
    if (errors.length) metric('BeeIngestionErrors', errors.length);

    return { success: errors.length === 0, eventsIngested, signalsDetected, skipped, ignored, errors };
}

module.exports = { ingestBeeContext, extractSignalsFromText, selectWearerTexts };

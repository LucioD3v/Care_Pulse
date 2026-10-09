'use strict';

const { partitionKey, putRecordIfAbsent } = require('../care_repository');
const { getCareContext } = require('../care_service');
const { sleepIntensity } = require('../apl/wellnessSnapshotPayload');

const EVENT_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_BASELINE_SLEEP_HOURS = 8;

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

function detectIntensity(text) {
    if (HIGH_INTENSITY.test(text)) return 'high';
    if (MODERATE_INTENSITY.test(text)) return 'moderate';
    return 'low';
}

function extractSignalsFromText(texts) {
    const seen = new Set();
    const results = [];
    for (const text of texts) {
        for (const { pattern, signal } of SIGNAL_PATTERNS) {
            if (!seen.has(signal) && pattern.test(text)) {
                seen.add(signal);
                results.push({ signal, intensity: detectIntensity(text), source: 'bee' });
            }
        }
    }
    return results;
}

function memberKey(memberName) {
    return String(memberName).trim().toLowerCase().replace(/\s+/g, '-');
}

function validateInput({ ownerId, memberName, beeExport }) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
        throw new TypeError('ownerId is required.');
    }
    if (typeof memberName !== 'string' || !memberName.trim()) {
        throw new TypeError('memberName is required.');
    }
    if (!beeExport || typeof beeExport !== 'object') {
        throw new TypeError('beeExport is required.');
    }
    // exportedAt keys every event, which is what makes re-ingesting the same export idempotent.
    if (typeof beeExport.exportedAt !== 'string' || Number.isNaN(Date.parse(beeExport.exportedAt))) {
        throw new TypeError('beeExport.exportedAt must be an ISO 8601 date-time.');
    }
    const sleepHours = beeExport.healthKit?.sleepHours;
    if (sleepHours !== undefined && (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 24)) {
        throw new TypeError('beeExport.healthKit.sleepHours must be a number between 0 and 24.');
    }
}

function exportTexts(beeExport) {
    const facts = Array.isArray(beeExport.facts) ? beeExport.facts : [];
    const conversations = Array.isArray(beeExport.conversations) ? beeExport.conversations : [];
    return [
        ...facts.map(fact => fact?.content),
        ...conversations.map(conversation => conversation?.summary)
    ].filter(text => typeof text === 'string' && text.trim());
}

async function ingestBeeContext(input) {
    validateInput(input);
    const { ownerId, memberName, beeExport } = input;
    const startedAt = Date.now();
    const pk = partitionKey(ownerId);
    const recordedAt = new Date(beeExport.exportedAt).toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + EVENT_TTL_SECONDS;
    const eventPrefix = `EVENT#${memberKey(memberName)}#${recordedAt}`;

    const events = extractSignalsFromText(exportTexts(beeExport)).map(({ signal, intensity }) => ({
        sk: `${eventPrefix}#bee-text-${signal}`,
        signal,
        state: intensity,
        details: 'Detected in Bee conversation context'
    }));

    const sleepHours = beeExport.healthKit?.sleepHours;
    if (sleepHours !== undefined) {
        const context = await getCareContext({ ownerId, memberName });
        const baseline = Number(context.baselineSleepHours ?? context.sleepHoursBaseline ?? DEFAULT_BASELINE_SLEEP_HOURS);
        events.push({
            sk: `${eventPrefix}#bee-healthkit-sleep`,
            signal: 'sleep',
            state: sleepIntensity(sleepHours, baseline),
            numericValue: sleepHours,
            details: `${sleepHours} hours from Bee HealthKit (baseline ${baseline} hours)`
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
                expiresAt
            });
            written ? eventsIngested++ : skipped++;
        } catch (error) {
            errors.push({ signal: event.signal, message: error.message });
        }
    }

    const signalsDetected = [...new Set(events.map(event => event.signal))];
    console.info(JSON.stringify({
        event: 'mcp_tool_completed',
        tool: 'ingest_bee_context',
        durationMs: Date.now() - startedAt,
        ownerId,
        memberName,
        outcome: errors.length ? 'partial' : 'ok'
    }));

    return { success: errors.length === 0, eventsIngested, signalsDetected, skipped, errors };
}

module.exports = { ingestBeeContext, extractSignalsFromText };

'use strict';

const { partitionKey, putRecordIfAbsent } = require('../care_repository');
const { getCareContext } = require('../care_service');
const { resolveBeeLink } = require('../bee_link');
const { sleepIntensity, verifiedSleepBaseline } = require('../care_baseline');
const { metric } = require('../observability');
const { createHash } = require('node:crypto');

const { retentionSeconds } = require('../runtime_config');

// English and Spanish, matched per clause on lowercase text without accents. Patterns marked
// "negated" already describe the problem through a negation ("not hungry", "no pude dormir").
const SIGNAL_PATTERNS = [
    { signal: 'tiredness', pattern: /\b(tired|exhausted|drained|worn out|cansad[oa]s?|agotad[oa]s?|sin energia)\b/g },
    { signal: 'sleep', pattern: /\b(insomnia|insomnio|slept badly|dormi mal)\b/g },
    { signal: 'sleep', negated: true, pattern: /\b(couldn'?t sleep|could not sleep|didn'?t sleep well|no (?:pude|puedo) dormir|no dormi bien)\b/g },
    { signal: 'mood', pattern: /\b(sad|anxious|stressed|depressed|triste|ansios[oa]s?|estresad[oa]s?|deprimid[oa]s?|angustiad[oa]s?)\b/g },
    { signal: 'appetite', negated: true, pattern: /\b(not hungry|no appetite|lost my appetite|no tengo (?:hambre|apetito)|sin (?:hambre|apetito)|perdi el apetito)\b/g },
    { signal: 'dizziness', pattern: /\b(dizzy|lightheaded|maread[oa]s?|mareos?)\b/g },
    { signal: 'discomfort', pattern: /\b(pain|aches?|aching|headaches?|hurts|dolor(?:es)?|me duele)\b/g }
];

const NEGATORS = new Set([
    'not', 'never', 'no', 'without', 'cannot', 'dont', 'didnt', 'cant', 'isnt', 'wasnt', 'arent', 'havent',
    'nunca', 'tampoco', 'ni', 'sin'
]);
const HIGH_INTENSITY = new Set(['extremely', 'completely', 'totally', 'incredibly', 'extremadamente', 'completamente', 'totalmente']);
const MODERATE_INTENSITY = new Set(['very', 'really', 'quite', 'muy', 'bastante']);
const NEGATION_WINDOW = 3;
const OTHER_PERSON = new RegExp([
    String.raw`\b(my|our|his|her|their)\s+(mother|father|mom|dad|brother|sister|friend|partner|child|daughter|son|husband|wife|grandma|grandpa|grandmother|grandfather|boss|neighbor)\b`,
    String.raw`\b(he|she|they|someone else)\b`,
    String.raw`\b(mi|mis|su|sus|nuestr[oa]s?)\s+(mama|papa|madre|padre|hermano|hermana|amigo|amiga|pareja|hijo|hija|esposo|esposa|abuela|abuelo|jefe|jefa|vecino|vecina|novio|novia|nieto|nieta)\b`,
    String.raw`\b(el|ella|ellos|ellas)\s+(esta|estan|tiene|tienen|se siente|se sienten)\b`
].join('|'));

function normalizeText(text) {
    return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'");
}

function precedingWords(clause, index) {
    return clause.slice(0, index).trim().split(/\s+/).filter(Boolean);
}

function isNegated(words) {
    return words.slice(-NEGATION_WINDOW).some(word => NEGATORS.has(word) || word.endsWith("n't"));
}

// Intensity comes only from the word right before the symptom; otherwise it is just "reported".
function detectIntensity(words) {
    const previous = words.at(-1) || '';
    if (HIGH_INTENSITY.has(previous)) return 'high';
    if (MODERATE_INTENSITY.has(previous)) return 'moderate';
    return 'reported';
}

function extractSignalsFromText(texts, memberName = '') {
    const member = normalizeText(memberName).trim();
    const found = new Map();
    for (const text of texts) {
        for (const clause of normalizeText(text).split(/[.!?;,:]|\b(?:but|pero|aunque|however)\b/)) {
            const trimmed = clause.trim();
            if (!trimmed) continue;
            if (OTHER_PERSON.test(trimmed) && !(member && trimmed.includes(member))) continue;
            for (const { pattern, signal, negated } of SIGNAL_PATTERNS) {
                if (found.has(signal)) continue;
                for (const match of trimmed.matchAll(pattern)) {
                    const words = precedingWords(trimmed, match.index);
                    if (!negated && isNegated(words)) continue;
                    found.set(signal, { signal, intensity: detectIntensity(words), source: 'bee' });
                    break;
                }
            }
        }
    }
    return [...found.values()];
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

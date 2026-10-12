'use strict';

const { verifiedSleepBaseline } = require('./care_baseline');

const { randomUUID, createHash } = require('node:crypto');
const { sendCaregiverAlert: publishCaregiverAlert } = require('./sns_notifier');
const { MCP_TOOLS } = require('./mcp_tools');
const {
    partitionKey,
    putRecord,
    putRecords,
    queryPage,
    queryPrefix,
    updateRecord,
    getRecord,
    deleteRecord,
    resetMockRecords
} = require('./care_repository');
const { RULE_VERSION, DEFAULT_TIME_ZONE, periodBounds, localDay, followupInstant } = require('./care_periods');

function normalized(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function historyRange(ownerId, memberName, period) {
    const prefix = 'EVENT#' + normalized(memberName) + '#';
    return { pk: partitionKey(ownerId), prefix, from: prefix + period.start, to: prefix + period.end + '#\uffff' };
}

async function getCareContext({ ownerId, memberName }) {
    const pk = partitionKey(ownerId);
    const memberKey = normalized(memberName);
    const existing = await getRecord(pk, 'CONTEXT#' + memberKey);
    if (existing) {
        return { ...existing,
            baselineSleepHours: existing.baselineSleepHours ?? verifiedSleepBaseline(existing),
            baselineSource: existing.baselineSource || 'unverified' };
    }
    const configured = process.env.DEMO_OWNER_ID === ownerId ? Number(process.env.DEFAULT_BASELINE_SLEEP_HOURS) : NaN;
    const demoBaseline = Number.isFinite(configured) && configured > 0 && configured <= 24 ? configured : null;
    return putRecord({
        pk,
        sk: `CONTEXT#${memberKey}`,
        entityType: 'CARE_CONTEXT',
        memberName,
        caregiverName: process.env.DEFAULT_CAREGIVER_NAME || 'Laura',
        baselineSleepHours: demoBaseline,
        baselineSource: demoBaseline === null ? 'unset' : 'demo',
        timezone: process.env.DEFAULT_TIME_ZONE || DEFAULT_TIME_ZONE,
        summaryLength: 'short',
        preferredFollowupTime: '18:00',
        followupOffers: 'on',
        createdAt: new Date().toISOString()
    });
}

async function updateCarePreferences({ ownerId, memberName, summaryLength, preferredFollowupTime, followupOffers }) {
    const changes = {};
    if (summaryLength !== undefined) {
        if (!['short', 'detailed'].includes(summaryLength)) {
            throw new TypeError('Summary length must be short or detailed.');
        }
        changes.summaryLength = summaryLength;
    }
    if (preferredFollowupTime !== undefined) {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferredFollowupTime)) {
            throw new TypeError('Preferred follow-up time must use HH:mm.');
        }
        changes.preferredFollowupTime = preferredFollowupTime;
    }
    if (followupOffers !== undefined) {
        if (!['on', 'off'].includes(followupOffers)) {
            throw new TypeError('Follow-up offers must be on or off.');
        }
        changes.followupOffers = followupOffers;
    }
    if (!Object.keys(changes).length) {
        throw new TypeError('At least one preference is required.');
    }
    const context = await getCareContext({ ownerId, memberName });
    return updateRecord(context.pk, context.sk, changes);
}

async function logWellnessEvent({ ownerId, memberName, signal, state, details = '', numericValue, recordedAt = new Date().toISOString(), source = 'voice' }) {
    if (!memberName || !signal || !state) {
        throw new TypeError('memberName, signal, and state are required to log a wellness event.');
    }
    recordedAt = new Date(recordedAt).toISOString();
    const pk = partitionKey(ownerId);
    const memberKey = normalized(memberName);
    return putRecord({
        pk,
        sk: `EVENT#${memberKey}#${recordedAt}#${randomUUID()}`,
        entityType: 'WELLNESS_EVENT',
        memberName,
        signal: normalized(signal),
        state: normalized(state),
        details,
        ...(Number.isFinite(Number(numericValue)) ? { numericValue: Number(numericValue) } : {}),
        recordedAt,
        provenance: source
    });
}

async function getWellnessHistory({ ownerId, memberName, timeframe = 'this week', limit = Infinity, context, now = new Date() }) {
    context ||= await getCareContext({ ownerId, memberName });
    const period = periodBounds(timeframe, context.timezone, now);
    const range = historyRange(ownerId, memberName, period);
    return queryPrefix(range.pk, range.prefix, limit, { from: range.from, to: range.to });
}

async function getWellnessHistoryPage({ ownerId, memberName, timeframe = 'this week', limit = 100, cursor }) {
    const context = await getCareContext({ ownerId, memberName });
    let after;
    let now = new Date();
    if (cursor) {
        try {
            const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
            if (typeof decoded.sk !== 'string' || typeof decoded.asOf !== 'string'
                || decoded.timeframe !== timeframe || decoded.timezone !== context.timezone
                || !decoded.sk.startsWith('EVENT#' + normalized(memberName) + '#')) throw new Error();
            now = new Date(decoded.asOf);
            if (!Number.isFinite(now.getTime()) || now > new Date()) throw new Error();
            after = { pk: partitionKey(ownerId), sk: decoded.sk };
        } catch {
            throw new TypeError('Invalid history cursor.');
        }
    }
    const period = periodBounds(timeframe, context.timezone, now);
    const range = historyRange(ownerId, memberName, period);
    if (after && (after.sk < range.from || after.sk > range.to)) throw new TypeError('Invalid history cursor.');
    const page = await queryPage(range.pk, range.prefix, { limit, cursor: after, from: range.from, to: range.to });
    return {
        events: page.items, period,
        nextCursor: page.cursor ? Buffer.from(JSON.stringify({
            sk: page.cursor.sk, asOf: period.end, timeframe, timezone: context.timezone
        })).toString('base64url') : null
    };
}

async function compareWithBaseline({ ownerId, memberName, signal, context, now = new Date() }) {
    context ||= await getCareContext({ ownerId, memberName });
    const history = await getWellnessHistory({ ownerId, memberName, context, now });
    const signalKey = normalized(signal);
    const repeated = history.filter(event => event.signal === signalKey
        && ['more-than-usual', 'same', 'worse'].includes(event.state));
    const repeatedDays = new Set(repeated.map(event => localDay(event.recordedAt, context.timezone))).size;
    const sleepByDay = new Map();
    for (const event of history) {
        if (event.signal === 'sleep' && Number.isFinite(event.numericValue)) {
            const day = localDay(event.recordedAt, context.timezone);
            if (!sleepByDay.has(day)) sleepByDay.set(day, event.numericValue);
        }
    }
    const averageSleep = sleepByDay.size ? [...sleepByDay.values()].reduce((a, b) => a + b, 0) / sleepByDay.size : null;
    const baseline = verifiedSleepBaseline(context);
    const hasBaseline = baseline !== null;
    const lessSleepThanRoutine = hasBaseline && sleepByDay.size >= 2 && averageSleep < baseline - 0.75;
    const parts = [];
    if (repeatedDays >= 2) parts.push('You reported ' + signalKey.replace(/-/g, ' ') + ' as unchanged, worse, or above usual on ' + repeatedDays + ' days in the last seven local days.');
    if (lessSleepThanRoutine) parts.push('Reported sleep averaged ' + averageSleep.toFixed(1) + ' hours across ' + sleepByDay.size + ' days, below the configured ' + baseline + '-hour routine.');
    return {
        memberName, signal: signalKey, repeatedCount: repeated.length, repeatedDays,
        averageSleep, sleepDays: sleepByDay.size, baselineSleepHours: hasBaseline ? baseline : null,
        lessSleepThanRoutine, changeObserved: repeatedDays >= 2 || lessSleepThanRoutine,
        observedDays: new Set(history.map(event => localDay(event.recordedAt, context.timezone))).size,
        period: periodBounds('this week', context.timezone, now), ruleVersion: RULE_VERSION,
        summary: parts.length ? parts.join(' ') + ' This describes your reports, not a diagnosis.'
            : 'There is not enough comparable information to describe a repeated change. Missing reports do not indicate how you feel.'
    };
}

async function createFollowup({ ownerId, memberName, signal, dueDate, dueTime }) {
    const followupId = randomUUID();
    const context = await getCareContext({ ownerId, memberName });
    const pk = partitionKey(ownerId);
    const record = {
        pk, sk: 'FOLLOWUP#' + normalized(memberName) + '#' + dueDate + 'T' + dueTime + '#' + followupId,
        entityType: 'FOLLOWUP', followupId, memberName, signal: normalized(signal),
        dueDate, dueTime, dueAt: followupInstant(dueDate, dueTime, context.timezone),
        pendingPartition: 'PENDING#' + (createHash('sha256').update(pk).digest()[0] % 16),
        status: 'pending', createdAt: new Date().toISOString()
    };
    await putRecords([record, {
        pk, sk: 'FOLLOWUP_ID#' + followupId, entityType: 'FOLLOWUP_REFERENCE',
        followupSk: record.sk, memberName
    }]);
    return record;
}

async function getFollowupById({ ownerId, memberName, followupId }) {
    const pk = partitionKey(ownerId);
    const reference = await getRecord(pk, 'FOLLOWUP_ID#' + followupId);
    if (reference) {
        if (normalized(reference.memberName) !== normalized(memberName)) return null;
        return getRecord(pk, reference.followupSk);
    }
    // Preserve access to records created before the reference records were introduced.
    const records = await queryPrefix(pk, 'FOLLOWUP#' + normalized(memberName) + '#');
    return records.find(record => record.followupId === followupId) || null;
}

async function getPendingFollowup({ ownerId, memberName, dueOnly = false, localDate, localTime }) {
    let cursor;
    do {
        const page = await queryPage(partitionKey(ownerId), 'FOLLOWUP#' + normalized(memberName) + '#', { ascending: true, cursor });
        const pending = page.items.find(record => record.status === 'pending'
            && (!dueOnly || record.dueDate + 'T' + record.dueTime <= localDate + 'T' + localTime));
        if (pending) return pending;
        cursor = page.cursor;
    } while (cursor);
    return null;
}

async function completeFollowup({ followup, status }) {
    return updateRecord(followup.pk, followup.sk, {
        status: 'completed',
        result: normalized(status),
        completedAt: new Date().toISOString()
    }, ['pendingPartition']);
}

async function requestConsent({ ownerId, memberName, caregiverName, signal, followupId, expiresAt = Math.floor(Date.now() / 1000) + 36 * 60 * 60 }) {
    const consentId = randomUUID();
    return putRecord({
        pk: partitionKey(ownerId),
        sk: `CONSENT#${normalized(memberName)}#${normalized(caregiverName)}#${followupId}`,
        entityType: 'CONSENT',
        consentId,
        memberName,
        caregiverName,
        signal: normalized(signal),
        followupId,
        scope: 'share-minimum-summary-if-signal-repeats',
        status: 'active',
        grantedAt: new Date().toISOString(),
        expiresAt
    });
}

async function findActiveConsent({ ownerId, memberName, caregiverName, signal, followupId }) {
    const record = await getRecord(partitionKey(ownerId),
        'CONSENT#' + normalized(memberName) + '#' + normalized(caregiverName) + '#' + followupId);
    return record && record.status === 'active' && record.followupId === followupId
        && record.signal === normalized(signal) && record.expiresAt > Math.floor(Date.now() / 1000)
        ? record : null;
}

async function evaluateAlertPolicy({ ownerId, memberName, caregiverName, signal, followupId, followupStatus }) {
    if (!['same', 'worse'].includes(normalized(followupStatus))) {
        return { allowed: false, reason: 'condition_not_repeated' };
    }
    const consent = await findActiveConsent({ ownerId, memberName, caregiverName, signal, followupId });
    if (!consent) {
        return { allowed: false, reason: 'consent_missing_or_expired' };
    }
    return {
        allowed: true,
        reason: 'repeat_condition_with_active_scoped_consent',
        consentId: consent.consentId
    };
}

async function sendCaregiverAlert(input) {
    if (!input.authorized || !input.consentId) {
        throw new Error('A caregiver alert requires an allowed policy decision and active consent.');
    }
    return publishCaregiverAlert(input);
}

async function createMcpSession({ protocolVersion = '2025-11-25' } = {}) {
    const sessionId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    await putRecord({
        pk: `MCPSESSION#${sessionId}`,
        sk: 'SESSION',
        entityType: 'MCP_SESSION',
        sessionId,
        protocolVersion,
        initialized: false,
        createdAt: new Date().toISOString(),
        expiresAt
    });
    return { sessionId, expiresAt };
}

async function getMcpSession(sessionId) {
    if (!sessionId) {
        return null;
    }
    const pk = `MCPSESSION#${sessionId}`;
    const session = await getRecord(pk, 'SESSION');
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
        return null;
    }
    return session;
}

async function deleteMcpSession(sessionId) {
    const pk = `MCPSESSION#${sessionId}`;
    await deleteRecord(pk, 'SESSION');
}

async function getWellnessSnapshot({ ownerId, memberName, timeframe = 'this week', context, now = new Date(),
    history: suppliedHistory, pending: suppliedPending }) {
    context ||= await getCareContext({ ownerId, memberName });
    const [history, pending] = await Promise.all([
        suppliedHistory ?? getWellnessHistory({ ownerId, memberName, timeframe, context, now }),
        suppliedPending !== undefined ? suppliedPending : getPendingFollowup({ ownerId, memberName })
    ]);
    return {
        memberName, timeframe, eventCount: history.length,
        signals: [...new Set(history.map(event => event.signal.replace(/-/g, ' ')))],
        status: history.length ? 'reports recorded' : 'no reports in this period',
        observedDays: new Set(history.map(event => localDay(event.recordedAt, context.timezone))).size,
        period: periodBounds(timeframe, context.timezone, now), ruleVersion: RULE_VERSION,
        followup: pending ? 'pending for ' + pending.dueDate + ' at ' + pending.dueTime : 'none pending'
    };
}

async function getCareDashboard({ ownerId, memberName, context: suppliedContext,
    history: suppliedHistory, followup: suppliedFollowup, now = new Date() }) {
    const context = suppliedContext || await getCareContext({ ownerId, memberName });
    const [history, followup] = await Promise.all([
        suppliedHistory?.length ? suppliedHistory
            : getWellnessHistory({ ownerId, memberName, timeframe: 'this month', limit: 1, context, now }),
        suppliedFollowup !== undefined ? suppliedFollowup : getPendingFollowup({ ownerId, memberName })
    ]);
    const consent = followup ? await findActiveConsent({
        ownerId,
        memberName,
        caregiverName: context.caregiverName,
        signal: followup.signal,
        followupId: followup.followupId
    }) : null;
    const lastReportDate = history[0]
        ? new Intl.DateTimeFormat('en-US', { timeZone: context.timezone || 'America/Mexico_City', year: 'numeric', month: 'short', day: 'numeric' })
            .format(new Date(history[0].recordedAt))
        : null;
    return {
        lastReport: history[0] ? `${history[0].signal.replace(/-/g, ' ')} on ${lastReportDate}` : 'No recent report',
        nextFollowup: followup ? `${followup.dueDate} at ${followup.dueTime}` : 'None scheduled',
        permission: !followup ? 'No follow-up awaiting permission'
            : consent ? `Active for ${context.caregiverName} on this follow-up`
                : `No active permission for ${context.caregiverName} on the next follow-up`
    };
}

async function callTool(name, input, { context } = {}) {
    const { validateToolInput } = require('./mcp_contracts');
    validateToolInput(name, input);
    const handlers = {
        get_care_context: getCareContext,
        log_wellness_event: logWellnessEvent,
        get_wellness_history: getWellnessHistory,
        compare_with_baseline: compareWithBaseline,
        create_followup: createFollowup,
        request_consent: requestConsent,
        send_caregiver_alert: sendCaregiverAlert,
        ingest_bee_context: (input) => require('./tools/ingestBeeContext').ingestBeeContext(input)
    };
    if (!handlers[name]) {
        throw new Error(`Unknown MCP tool: ${name}`);
    }
    return handlers[name](name === 'compare_with_baseline' && context ? { ...input, context } : input);
}

module.exports = {
    MCP_TOOLS,
    callTool,
    getCareContext,
    updateCarePreferences,
    logWellnessEvent,
    getWellnessHistory,
    getWellnessHistoryPage,
    compareWithBaseline,
    createFollowup,
    getFollowupById,
    getPendingFollowup,
    completeFollowup,
    requestConsent,
    findActiveConsent,
    evaluateAlertPolicy,
    sendCaregiverAlert,
    createMcpSession,
    getMcpSession,
    deleteMcpSession,
    getWellnessSnapshot,
    getCareDashboard,
    resetMockRecords
};

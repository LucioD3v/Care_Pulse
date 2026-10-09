'use strict';

const { randomUUID } = require('node:crypto');
const { sendCaregiverAlert: publishCaregiverAlert } = require('./sns_notifier');
const { MCP_TOOLS } = require('./mcp_tools');
const {
    partitionKey,
    putRecord,
    queryPrefix,
    updateRecord,
    getRecord,
    deleteRecord,
    resetMockRecords
} = require('./care_repository');

function normalized(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function timeframeStart(timeframe) {
    const duration = timeframe === 'today' ? 24 * 60 * 60 * 1000
        : timeframe === 'this month' ? 30 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - duration).toISOString();
}

async function getCareContext({ ownerId, memberName }) {
    const pk = partitionKey(ownerId);
    const memberKey = normalized(memberName);
    const [existing] = await queryPrefix(pk, `CONTEXT#${memberKey}`, 1);
    if (existing) {
        return existing;
    }
    return putRecord({
        pk,
        sk: `CONTEXT#${memberKey}`,
        entityType: 'CARE_CONTEXT',
        memberName,
        caregiverName: process.env.DEFAULT_CAREGIVER_NAME || 'Laura',
        baselineSleepHours: Number(process.env.DEFAULT_BASELINE_SLEEP_HOURS || 7.5),
        timezone: process.env.DEFAULT_TIME_ZONE || 'America/Mexico_City',
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

async function getWellnessHistory({ ownerId, memberName, timeframe = 'this week', limit = 100 }) {
    const records = await queryPrefix(partitionKey(ownerId), `EVENT#${normalized(memberName)}#`, limit);
    const start = timeframeStart(timeframe);
    return records.filter(record => record.recordedAt >= start).slice(0, limit);
}

async function compareWithBaseline({ ownerId, memberName, signal }) {
    const [context, history] = await Promise.all([
        getCareContext({ ownerId, memberName }),
        getWellnessHistory({ ownerId, memberName, timeframe: 'this week', limit: 50 })
    ]);
    const signalKey = normalized(signal);
    const matchingEvents = history.filter(event => event.signal === signalKey);
    const sleepValues = history
        .filter(event => event.signal === 'sleep' && Number.isFinite(event.numericValue))
        .map(event => event.numericValue);
    const averageSleep = sleepValues.length
        ? sleepValues.reduce((sum, value) => sum + value, 0) / sleepValues.length
        : null;
    const lessSleepThanRoutine = averageSleep !== null
        && averageSleep < Number(context.baselineSleepHours) - 0.75;
    const repeatedSignal = matchingEvents.length >= 2;
    return {
        memberName,
        signal: signalKey,
        repeatedCount: matchingEvents.length,
        averageSleep,
        baselineSleepHours: context.baselineSleepHours,
        lessSleepThanRoutine,
        changeObserved: repeatedSignal || lessSleepThanRoutine,
        summary: buildBaselineSummary(signalKey, matchingEvents.length, lessSleepThanRoutine)
    };
}

function buildBaselineSummary(signal, repeatedCount, lessSleepThanRoutine) {
    const parts = [];
    if (repeatedCount >= 2) {
        parts.push(`I found ${repeatedCount} ${signal.replace(/-/g, ' ')} reports this week`);
    }
    if (lessSleepThanRoutine) {
        parts.push('sleep has also been below the usual routine');
    }
    return parts.length
        ? `${parts.join(', and ')}. This is a change worth following up on, not a diagnosis.`
        : 'I do not have enough recent information to identify a change yet.';
}

async function createFollowup({ ownerId, memberName, signal, dueDate, dueTime }) {
    const followupId = randomUUID();
    return putRecord({
        pk: partitionKey(ownerId),
        sk: `FOLLOWUP#${normalized(memberName)}#${dueDate}T${dueTime}#${followupId}`,
        entityType: 'FOLLOWUP',
        followupId,
        memberName,
        signal: normalized(signal),
        dueDate,
        dueTime,
        status: 'pending',
        createdAt: new Date().toISOString()
    });
}

async function getPendingFollowup({ ownerId, memberName, dueOnly = false, localDate, localTime }) {
    const followups = await queryPrefix(partitionKey(ownerId), `FOLLOWUP#${normalized(memberName)}#`, 25);
    return followups.find(followup => {
        if (followup.status !== 'pending') {
            return false;
        }
        if (!dueOnly) {
            return true;
        }
        return `${followup.dueDate}T${followup.dueTime}` <= `${localDate}T${localTime}`;
    }) || null;
}

async function completeFollowup({ followup, status }) {
    return updateRecord(followup.pk, followup.sk, {
        status: 'completed',
        result: normalized(status),
        completedAt: new Date().toISOString()
    });
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
    const records = await queryPrefix(
        partitionKey(ownerId),
        `CONSENT#${normalized(memberName)}#${normalized(caregiverName)}#`,
        25
    );
    const now = Math.floor(Date.now() / 1000);
    return records.find(record => record.status === 'active'
        && record.followupId === followupId
        && record.signal === normalized(signal)
        && record.expiresAt > now) || null;
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

async function createMcpSession({ clientInfo = {} } = {}) {
    const sessionId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    await putRecord({
        pk: `MCPSESSION#${sessionId}`,
        sk: 'SESSION',
        entityType: 'MCP_SESSION',
        sessionId,
        clientInfo,
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

async function getWellnessSnapshot({ ownerId, memberName, timeframe = 'this week' }) {
    const history = await getWellnessHistory({ ownerId, memberName, timeframe, limit: 50 });
    const pending = await getPendingFollowup({ ownerId, memberName });
    const signals = [...new Set(history.map(event => event.signal.replace(/-/g, ' ')))];
    return {
        memberName,
        timeframe,
        eventCount: history.length,
        signals,
        status: history.length >= 2 ? 'change observed' : 'not enough information',
        followup: pending ? `pending for ${pending.dueDate} at ${pending.dueTime}` : 'none pending'
    };
}

async function getCareDashboard({ ownerId, memberName }) {
    const [history, followup, context] = await Promise.all([
        getWellnessHistory({ ownerId, memberName, timeframe: 'this month', limit: 1 }),
        getPendingFollowup({ ownerId, memberName }),
        getCareContext({ ownerId, memberName })
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

async function callTool(name, input) {
    const handlers = {
        get_care_context: getCareContext,
        log_wellness_event: logWellnessEvent,
        get_wellness_history: getWellnessHistory,
        compare_with_baseline: compareWithBaseline,
        create_followup: createFollowup,
        request_consent: requestConsent,
        send_caregiver_alert: sendCaregiverAlert
    };
    if (!handlers[name]) {
        throw new Error(`Unknown MCP tool: ${name}`);
    }
    return handlers[name](input);
}

module.exports = {
    MCP_TOOLS,
    callTool,
    getCareContext,
    updateCarePreferences,
    logWellnessEvent,
    getWellnessHistory,
    compareWithBaseline,
    createFollowup,
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

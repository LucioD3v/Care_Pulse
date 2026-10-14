'use strict';

const { verifiedSleepBaseline } = require('./care_baseline');
const { authorizeMember, currentPrincipal, AccessError } = require('./access_control');
const { isDemo, retentionSeconds } = require('./runtime_config');
const { validateSignal, validateReport } = require('./care_validation');
const { saveOperation } = require('./care_idempotency');

const { randomUUID, createHash } = require('node:crypto');
const { sendCaregiverAlert: publishCaregiverAlert } = require('./sns_notifier');
const { MCP_TOOLS } = require('./mcp_tools');
const {
    partitionKey,
    putRecord,
    commit,
    isConflict,
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
    authorizeMember(ownerId, memberName);
    const pk = partitionKey(ownerId);
    const memberKey = normalized(memberName);
    const existing = await getRecord(pk, 'CONTEXT#' + memberKey);
    if (existing) {
        return { ...existing,
            baselineSleepHours: existing.baselineSleepHours ?? verifiedSleepBaseline(existing),
            baselineSource: existing.baselineSource || 'unverified',
            discreetMode: existing.discreetMode || (isDemo() ? 'off' : 'on') };
    }
    if (!isDemo()) throw new AccessError();
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
        discreetMode: isDemo() ? 'off' : 'on',
        createdAt: new Date().toISOString()
    });
}

async function updateCarePreferences({ ownerId, memberName, summaryLength, preferredFollowupTime, followupOffers, discreetMode }) {
    authorizeMember(ownerId, memberName, true);
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
    if (discreetMode !== undefined) {
        if (!['on', 'off'].includes(discreetMode)) throw new TypeError('Discreet mode must be on or off.');
        changes.discreetMode = discreetMode;
    }
    if (!Object.keys(changes).length) {
        throw new TypeError('At least one preference is required.');
    }
    const context = await getCareContext({ ownerId, memberName });
    return updateRecord(context.pk, context.sk, changes);
}

async function logWellnessEvent({ ownerId, memberName, signal, state, details = '', numericValue, recordedAt, source = 'voice' }) {
    authorizeMember(ownerId, memberName, true);
    if (!memberName || !signal || !state) {
        throw new TypeError('memberName, signal, and state are required to log a wellness event.');
    }
    validateReport(signal, state, numericValue);
    const input = { memberName, signal, state, details, numericValue, recordedAt, source };
    recordedAt = new Date(recordedAt || Date.now()).toISOString();
    const pk = partitionKey(ownerId);
    const memberKey = normalized(memberName);
    return saveOperation(pk, 'report', input, [{
        pk,
        sk: `EVENT#${memberKey}#${recordedAt}#${randomUUID()}`,
        entityType: 'WELLNESS_EVENT',
        memberName,
        signal: normalized(signal),
        state: normalized(state),
        details,
        ...(Number.isFinite(Number(numericValue)) ? { numericValue: Number(numericValue) } : {}),
        recordedAt,
        provenance: source,
        expiresAt: Math.floor(Date.now() / 1000) + retentionSeconds()
    }]);
}

async function correctWellnessEvent({ ownerId, memberName, correctedMemberName = memberName, eventSk, signal, state, numericValue }) {
    authorizeMember(ownerId, memberName, true);
    authorizeMember(ownerId, correctedMemberName, true);
    const pk = partitionKey(ownerId);
    if (!eventSk?.startsWith('EVENT#' + normalized(memberName) + '#')) throw new TypeError('The report cannot be corrected.');
    const event = await getRecord(pk, eventSk);
    if (!event || event.provenance !== 'voice' || event.memberName !== memberName) {
        throw new TypeError('The report cannot be corrected.');
    }
    const nextSignal = signal || event.signal;
    const nextState = state || event.state;
    const nextValue = numericValue === undefined ? event.numericValue : numericValue;
    validateReport(nextSignal, nextState, nextValue);
    const corrected = { ...event, signal: normalized(nextSignal), state: normalized(nextState),
        memberName: correctedMemberName,
        details: nextValue === undefined ? '' : `${nextValue} hours`, correctedAt: new Date().toISOString() };
    if (nextValue === undefined) delete corrected.numericValue;
    else corrected.numericValue = Number(nextValue);
    const unchanged = { equals: { signal: event.signal, state: event.state, recordedAt: event.recordedAt,
        ...(event.correctedAt ? { correctedAt: event.correctedAt } : {}) },
    ...(event.correctedAt ? {} : { missing: ['correctedAt'] }) };
    if (correctedMemberName !== memberName) {
        corrected.sk = `EVENT#${normalized(correctedMemberName)}#${event.recordedAt}#${randomUUID()}`;
        await commit({ puts: [{ item: corrected, absent: true }],
            deletes: [{ pk, sk: eventSk, ...unchanged }] });
    } else {
        await commit({ puts: [{ item: corrected, ...unchanged }] });
    }
    return corrected;
}

async function getWellnessHistory({ ownerId, memberName, timeframe = 'this week', limit = Infinity, context, now = new Date() }) {
    authorizeMember(ownerId, memberName);
    context ||= await getCareContext({ ownerId, memberName });
    const period = periodBounds(timeframe, context.timezone, now);
    const range = historyRange(ownerId, memberName, period);
    const events = await queryPrefix(range.pk, range.prefix, Infinity, { from: range.from, to: range.to });
    return events.filter(event => !event.expiresAt || event.expiresAt > Math.floor(Date.now() / 1000)).slice(0, limit);
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
        events: page.items.filter(event => !event.expiresAt || event.expiresAt > Math.floor(Date.now() / 1000)), period,
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
    authorizeMember(ownerId, memberName, true);
    validateSignal(signal);
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
    return saveOperation(pk, 'followup', { memberName, signal, dueDate, dueTime }, [record, {
        pk, sk: 'FOLLOWUP_ID#' + followupId, entityType: 'FOLLOWUP_REFERENCE',
        followupSk: record.sk, memberName
    }]);
}

async function getFollowupById({ ownerId, memberName, followupId }) {
    authorizeMember(ownerId, memberName);
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

async function getPendingFollowup({ ownerId, memberName, dueOnly = false, localDate, localTime, signal, dueDate, dueTime }) {
    authorizeMember(ownerId, memberName);
    let cursor;
    do {
        const page = await queryPage(partitionKey(ownerId), 'FOLLOWUP#' + normalized(memberName) + '#', { ascending: true, cursor });
        const pending = page.items.find(record => record.status === 'pending'
            && (!signal || record.signal === normalized(signal))
            && (!dueDate || record.dueDate === dueDate) && (!dueTime || record.dueTime === dueTime)
            && (!dueOnly || record.dueDate + 'T' + record.dueTime <= localDate + 'T' + localTime));
        if (pending) return pending;
        cursor = page.cursor;
    } while (cursor);
    return null;
}

async function completeFollowup({ followup, status }) {
    const ownerId = String(followup.pk).replace(/^USER#/, '');
    authorizeMember(ownerId, followup.memberName, true);
    status = normalized(status);
    if (!['better', 'same', 'worse'].includes(status)) throw new TypeError('Invalid follow-up status.');
    const stored = await getFollowupById({ ownerId, memberName: followup.memberName, followupId: followup.followupId });
    if (!stored) throw new TypeError('Follow-up was not found.');
    if (stored.status === 'completed' && stored.result === status) return stored;
    if (stored.status !== 'pending') throw new TypeError('Follow-up is no longer pending.');
    const completedAt = new Date().toISOString();
    const completed = { ...stored, status: 'completed', result: status, completedAt };
    delete completed.pendingPartition;
    const event = {
        pk: stored.pk, sk: 'EVENT#' + normalized(stored.memberName) + '#' + completedAt + '#' + stored.followupId,
        entityType: 'WELLNESS_EVENT', memberName: stored.memberName, signal: stored.signal,
        state: status, details: 'scheduled follow-up response', recordedAt: completedAt, provenance: 'voice',
        expiresAt: Math.floor(Date.now() / 1000) + retentionSeconds()
    };
    const puts = [
        { item: completed, equals: { status: 'pending', ...(stored.consentVersion ? { consentVersion: stored.consentVersion } : {}) },
            ...(!stored.consentVersion ? { missing: ['consentVersion'] } : {}) },
        { item: event, absent: true }
    ];
    const requestId = currentPrincipal()?.requestId;
    if (requestId) puts.push({ item: {
        pk: stored.pk, sk: 'COMPLETION_REQUEST#' + createHash('sha256').update(requestId).digest('hex'),
        followupId: stored.followupId, memberName: stored.memberName,
        expiresAt: Math.floor(Date.now() / 1000) + retentionSeconds()
    }, absent: true });
    if (stored.consentId && ['same', 'worse'].includes(status)) {
        puts.push({ item: {
            pk: stored.pk, sk: 'ALERT#' + stored.followupId, entityType: 'ALERT_OUTBOX',
            memberName: stored.memberName, followupId: stored.followupId,
            consentId: stored.consentId, consentSk: stored.consentSk, status: 'pending',
            createdAt: completedAt, attempts: 0
        }, absent: true });
    }
    try { await commit({ puts }); }
    catch (error) {
        if (!isConflict(error)) throw error;
        const current = await getRecord(stored.pk, stored.sk);
        if (current?.status === 'completed' && current.result === status) return current;
        throw new TypeError('Follow-up changed. Please review it before trying again.');
    }
    return completed;
}

async function getCompletionForRequest({ ownerId, memberName }) {
    authorizeMember(ownerId, memberName, true);
    const requestId = currentPrincipal()?.requestId;
    if (!requestId) return null;
    const reference = await getRecord(partitionKey(ownerId),
        'COMPLETION_REQUEST#' + createHash('sha256').update(requestId).digest('hex'));
    if (!reference) return null;
    if (reference.memberName !== memberName) throw new TypeError('Completion request was reused for another member.');
    return getFollowupById({ ownerId, memberName, followupId: reference.followupId });
}

async function listFollowups({ ownerId, memberName }) {
    authorizeMember(ownerId, memberName);
    const records = await queryPrefix(partitionKey(ownerId), 'FOLLOWUP#' + normalized(memberName) + '#');
    return { followups: records.filter(record => record.status === 'pending')
        .sort((a, b) => `${a.dueDate}T${a.dueTime}`.localeCompare(`${b.dueDate}T${b.dueTime}`)
            || String(a.followupId).localeCompare(String(b.followupId))) };
}

async function rescheduleFollowup({ ownerId, memberName, followupId, dueDate, dueTime }) {
    authorizeMember(ownerId, memberName, true);
    const followup = await getFollowupById({ ownerId, memberName, followupId });
    if (!followup || followup.status !== 'pending') throw new TypeError('Only a pending follow-up can be rescheduled.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) {
        throw new TypeError('A specific date and time are required.');
    }
    if (followup.dueDate === dueDate && followup.dueTime === dueTime) return followup;
    const context = await getCareContext({ ownerId, memberName });
    const newSk = 'FOLLOWUP#' + normalized(memberName) + '#' + dueDate + 'T' + dueTime + '#' + followupId;
    const moved = { ...followup, sk: newSk, dueDate, dueTime,
        dueAt: followupInstant(dueDate, dueTime, context.timezone), rescheduledAt: new Date().toISOString() };
    delete moved.consentId;
    delete moved.consentSk;
    delete moved.consentVersion;
    delete moved.caregiverName;
    const referenceSk = 'FOLLOWUP_ID#' + followupId;
    const reference = await getRecord(followup.pk, referenceSk);
    const puts = [{ item: moved, absent: true }];
    if (reference) puts.push({ item: { ...reference, followupSk: newSk }, equals: { followupSk: followup.sk } });
    else puts.push({ item: { pk: followup.pk, sk: referenceSk, entityType: 'FOLLOWUP_REFERENCE',
        followupSk: newSk, memberName }, absent: true });
    if (followup.consentSk) {
        const consent = await getRecord(followup.pk, followup.consentSk);
        if (consent?.status === 'active') puts.push({ item: { ...consent, status: 'revoked', revokedAt: new Date().toISOString() },
            equals: { status: 'active', followupId } });
    }
    try {
        await commit({ puts, deletes: [{ pk: followup.pk, sk: followup.sk,
            equals: { status: 'pending', dueDate: followup.dueDate, dueTime: followup.dueTime,
                ...(followup.consentVersion ? { consentVersion: followup.consentVersion } : {}) } }] });
    } catch (error) {
        if (isConflict(error)) throw new TypeError('Follow-up changed. Please review it before trying again.');
        throw error;
    }
    return moved;
}

async function cancelFollowup({ ownerId, memberName, followupId }) {
    authorizeMember(ownerId, memberName, true);
    const followup = await getFollowupById({ ownerId, memberName, followupId });
    if (!followup) throw new TypeError('Follow-up was not found.');
    if (followup.status === 'cancelled') return followup;
    if (followup.status !== 'pending') throw new TypeError('Only pending follow-ups can be cancelled.');
    await revokeConsent({ ownerId, memberName, followupId });
    const cancelled = { ...followup, status: 'cancelled', cancelledAt: new Date().toISOString() };
    delete cancelled.pendingPartition;
    await commit({ puts: [{ item: cancelled, equals: { status: 'pending' } }] });
    return cancelled;
}

async function revokeMemberSharing({ ownerId, memberName }) {
    authorizeMember(ownerId, memberName, true);
    const records = await queryPrefix(partitionKey(ownerId), 'FOLLOWUP#' + normalized(memberName) + '#');
    let mayHaveBeenSent = false;
    for (const followup of records) {
        const result = await revokeConsent({ ownerId, memberName, followupId: followup.followupId });
        mayHaveBeenSent ||= result.mayHaveBeenSent;
    }
    return { mayHaveBeenSent };
}

async function resolveCaregiver({ ownerId, memberName, caregiverName }) {
    authorizeMember(ownerId, memberName, true);
    if (!caregiverName) throw new TypeError('A caregiver is required.');
    if (isDemo()) return { caregiverId: 'demo-' + normalized(caregiverName), destinationVersion: 'demo' };
    const member = authorizeMember(ownerId, memberName, true);
    const caregiver = await getRecord(partitionKey(ownerId), 'CAREGIVER#' + normalized(caregiverName));
    if (!caregiver || caregiver.status !== 'verified' || !caregiver.caregiverId
        || !caregiver.memberIds?.includes(member.memberId) || !caregiver.destinationVersion
        || !caregiver.topicArn || !caregiver.subscriptionArn || !caregiver.endpoint) throw new AccessError();
    return caregiver;
}

async function requestConsent({ ownerId, memberName, caregiverName, signal, followupId,
    expiresAt = Math.floor(Date.now() / 1000) + 36 * 60 * 60 }) {
    authorizeMember(ownerId, memberName, true);
    // A model tool call cannot stand in for a person's affirmative confirmation. This also covers
    // Alexa+ OAuth callers in demo mode, which are driven by a model rather than the skill's YesIntent.
    const principal = currentPrincipal();
    if ((!isDemo() || principal?.viaToken) && principal?.channel !== 'alexa') throw new AccessError();
    const followup = await getFollowupById({ ownerId, memberName, followupId });
    const now = Math.floor(Date.now() / 1000);
    if (!followup || followup.status !== 'pending' || followup.signal !== normalized(signal)) {
        throw new TypeError('Consent must match a pending follow-up and signal.');
    }
    if (!Number.isInteger(expiresAt) || expiresAt <= now || expiresAt > now + 36 * 60 * 60) {
        throw new TypeError('Consent must expire within thirty-six hours.');
    }
    const caregiver = await resolveCaregiver({ ownerId, memberName, caregiverName });
    const consent = {
        pk: partitionKey(ownerId),
        sk: 'CONSENT#' + normalized(memberName) + '#' + normalized(caregiverName) + '#' + followupId,
        entityType: 'CONSENT', consentId: randomUUID(), memberName, caregiverName,
        caregiverId: caregiver.caregiverId, destinationVersion: caregiver.destinationVersion,
        signal: normalized(signal), followupId, scope: 'share-minimum-summary-if-signal-repeats',
        status: 'active', grantedAt: new Date().toISOString(), expiresAt
    };
    const bound = { ...followup, caregiverName, caregiverId: caregiver.caregiverId,
        consentId: consent.consentId, consentSk: consent.sk, consentVersion: randomUUID() };
    const previous = followup.consentSk ? await getRecord(followup.pk, followup.consentSk) : null;
    const puts = [
        { item: bound, equals: { status: 'pending', ...(followup.consentVersion ? { consentVersion: followup.consentVersion } : {}) },
            ...(!followup.consentVersion ? { missing: ['consentVersion'] } : {}) },
        { item: consent }
    ];
    if (previous && previous.sk !== consent.sk) puts.push({ item: { ...previous, status: 'revoked' } });
    await commit({ puts });
    return consent;
}

async function findActiveConsent({ ownerId, memberName, caregiverName, signal, followupId }) {
    authorizeMember(ownerId, memberName);
    const record = await getRecord(partitionKey(ownerId),
        'CONSENT#' + normalized(memberName) + '#' + normalized(caregiverName) + '#' + followupId);
    const followup = await getFollowupById({ ownerId, memberName, followupId });
    return record && record.status === 'active' && record.followupId === followupId
        && normalized(record.caregiverName) === normalized(caregiverName)
        && record.signal === normalized(signal) && record.expiresAt > Math.floor(Date.now() / 1000)
        && followup?.consentId === record.consentId && followup.consentSk === record.sk
        ? record : null;
}

async function revokeConsent({ ownerId, memberName, followupId }) {
    authorizeMember(ownerId, memberName, true);
    const followup = await getFollowupById({ ownerId, memberName, followupId });
    if (!followup?.consentSk) return { revoked: false, mayHaveBeenSent: false };
    const consent = await getRecord(followup.pk, followup.consentSk);
    if (!consent) return { revoked: false, mayHaveBeenSent: false };
    // Publication already claimed by another invocation cannot be recalled.
    const job = await getRecord(followup.pk, 'ALERT#' + followupId);
    await commit({ puts: [{ item: { ...consent, status: 'revoked', revokedAt: new Date().toISOString() },
        equals: { consentId: consent.consentId } }] });
    if (job && ['pending', 'failed', 'unconfigured'].includes(job.status)) {
        try { await commit({ puts: [{ item: { ...job, status: 'cancelled' }, equals: { status: job.status } }] }); }
        catch (error) { if (!isConflict(error)) throw error; }
    }
    const latest = job ? await getRecord(job.pk, job.sk) : null;
    return { revoked: true, mayHaveBeenSent: ['sending', 'accepted', 'unknown'].includes(latest?.status) };
}

async function evaluateAlertPolicy({ ownerId, memberName, caregiverName, signal, followupId, followupStatus }) {
    authorizeMember(ownerId, memberName);
    if (!['same', 'worse'].includes(normalized(followupStatus))) {
        return { allowed: false, reason: 'condition_not_repeated' };
    }
    const consent = await findActiveConsent({ ownerId, memberName, caregiverName, signal, followupId });
    if (!consent) return { allowed: false, reason: 'consent_missing_or_expired' };
    return { allowed: true, reason: 'repeat_condition_with_active_scoped_consent', consentId: consent.consentId };
}

async function sendCaregiverAlert(input) {
    if (!input.ownerId || !input.consentId) throw new Error('A caregiver alert requires an allowed policy decision and active consent.');
    // Demo alerts go to the shared demo topic without destination verification, so a model-driven
    // Alexa+ caller must not trigger them; the voice skill still sends the alert after the check-in.
    if (isDemo() && currentPrincipal()?.viaToken) throw new AccessError();
    authorizeMember(input.ownerId, input.memberName, true);
    const pk = partitionKey(input.ownerId);
    const records = await queryPrefix(pk, 'CONSENT#' + normalized(input.memberName) + '#' + normalized(input.caregiverName) + '#');
    const consent = records.find(record => record.consentId === input.consentId);
    if (!consent) throw new AccessError();
    const active = await findActiveConsent({ ...input, followupId: consent.followupId });
    const followup = await getFollowupById({ ...input, followupId: consent.followupId });
    if (!active || followup?.status !== 'completed' || followup.result !== input.followupStatus
        || !['same', 'worse'].includes(followup.result)) throw new AccessError();
    const caregiver = await resolveCaregiver(input);
    if (caregiver.caregiverId !== consent.caregiverId || caregiver.destinationVersion !== consent.destinationVersion) throw new AccessError();
    const job = await getRecord(pk, 'ALERT#' + followup.followupId);
    if (!job || job.consentId !== consent.consentId) throw new AccessError();
    if (job.status === 'accepted') return { sent: true, simulated: false, status: 'accepted', messageId: job.messageId };
    if (!['pending', 'failed', 'unconfigured'].includes(job.status) || job.attempts >= 3) {
        return { sent: false, simulated: false, status: job.status === 'sending' ? 'unknown' : job.status };
    }
    const claimed = { ...job, status: 'sending', attempts: job.attempts + 1, claimId: randomUUID() };
    try {
        await commit({
            checks: [{ pk, sk: consent.sk, equals: { status: 'active', consentId: consent.consentId },
                after: { expiresAt: Math.floor(Date.now() / 1000) } }],
            puts: [{ item: claimed, equals: { status: job.status, attempts: job.attempts } }]
        });
    } catch (error) {
        if (!isConflict(error)) throw error;
        return { sent: false, simulated: false, status: 'unknown' };
    }
    const result = await publishCaregiverAlert({ ...input, destination: caregiver });
    await commit({ puts: [{ item: { ...claimed, status: result.status, messageId: result.messageId || null,
        updatedAt: new Date().toISOString() }, equals: { status: 'sending', claimId: claimed.claimId } }] });
    return result;
}

async function createMcpSession({ protocolVersion = '2025-11-25', ownerId = null } = {}) {
    const sessionId = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    await putRecord({
        pk: `MCPSESSION#${sessionId}`,
        sk: 'SESSION',
        entityType: 'MCP_SESSION',
        sessionId,
        ownerId,
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
    authorizeMember(ownerId, memberName);
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
        lastReportDate: history.length ? localDay(history[0].recordedAt, context.timezone) : null,
        period: periodBounds(timeframe, context.timezone, now), ruleVersion: RULE_VERSION,
        followup: pending ? 'pending for ' + pending.dueDate + ' at ' + pending.dueTime : 'none pending'
    };
}

async function getCareDashboard({ ownerId, memberName, context: suppliedContext,
    history: suppliedHistory, followup: suppliedFollowup, now = new Date() }) {
    authorizeMember(ownerId, memberName);
    const context = suppliedContext || await getCareContext({ ownerId, memberName });
    const [history, followup] = await Promise.all([
        suppliedHistory?.length ? suppliedHistory
            : getWellnessHistory({ ownerId, memberName, timeframe: 'this month', limit: 1, context, now }),
        suppliedFollowup !== undefined ? suppliedFollowup : getPendingFollowup({ ownerId, memberName })
    ]);
    const consent = followup ? await findActiveConsent({
        ownerId,
        memberName,
        caregiverName: followup.caregiverName || context.caregiverName,
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
            : consent ? `Active for ${followup.caregiverName || context.caregiverName} on this follow-up`
                : `No active permission for ${followup.caregiverName || context.caregiverName} on the next follow-up`
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
        list_followups: listFollowups,
        complete_followup: async input => {
            const followup = await getFollowupById(input);
            if (!followup) throw new TypeError('Follow-up was not found.');
            return completeFollowup({ followup, status: input.status });
        },
        cancel_followup: cancelFollowup,
        revoke_consent: revokeConsent,
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
    correctWellnessEvent,
    getWellnessHistory,
    getWellnessHistoryPage,
    compareWithBaseline,
    createFollowup,
    getFollowupById,
    getPendingFollowup,
    completeFollowup,
    getCompletionForRequest,
    listFollowups,
    rescheduleFollowup,
    cancelFollowup,
    revokeMemberSharing,
    requestConsent,
    revokeConsent,
    resolveCaregiver,
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

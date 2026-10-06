'use strict';

const { randomUUID } = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { sendCaregiverAlert: publishCaregiverAlert } = require('./sns_notifier');

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1'
}));
const mockRecords = [];

function objectSchema(properties, required) {
    return { type: 'object', properties, required, additionalProperties: false };
}

const MCP_TOOLS = [
    {
        name: 'get_care_context',
        description: 'Return the authorized care context, baseline, caregiver, and active preferences for one member.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' }
        }, ['ownerId', 'memberName'])
    },
    {
        name: 'log_wellness_event',
        description: 'Record a non-diagnostic wellness signal with provenance and timestamp.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            signal: { type: 'string' },
            state: { type: 'string' },
            details: { type: 'string' },
            numericValue: { type: 'number' },
            recordedAt: { type: 'string', format: 'date-time' },
            source: { type: 'string' }
        }, ['ownerId', 'memberName', 'signal', 'state'])
    },
    {
        name: 'get_wellness_history',
        description: 'Retrieve the minimum authorized wellness history needed for the current request.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            timeframe: { type: 'string', enum: ['today', 'this week', 'this month'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 }
        }, ['ownerId', 'memberName'])
    },
    {
        name: 'compare_with_baseline',
        description: 'Compare recent signals with a configured personal routine and report changes, not diagnoses.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            signal: { type: 'string' }
        }, ['ownerId', 'memberName', 'signal'])
    },
    {
        name: 'create_followup',
        description: 'Create a pending wellness check-in for a specific member and signal.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            signal: { type: 'string' },
            dueDate: { type: 'string' },
            dueTime: { type: 'string' }
        }, ['ownerId', 'memberName', 'signal', 'dueDate', 'dueTime'])
    },
    {
        name: 'request_consent',
        description: 'Record explicit, scoped, expiring consent before information is shared with a caregiver.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            caregiverName: { type: 'string' },
            signal: { type: 'string' },
            followupId: { type: 'string' },
            expiresAt: { type: 'integer' }
        }, ['ownerId', 'memberName', 'caregiverName', 'signal', 'followupId'])
    },
    {
        name: 'send_caregiver_alert',
        description: 'Send a minimum-data caregiver alert only after a deterministic policy decision permits it.',
        inputSchema: objectSchema({
            ownerId: { type: 'string' },
            memberName: { type: 'string' },
            caregiverName: { type: 'string' },
            signal: { type: 'string' },
            followupStatus: { type: 'string' },
            consentId: { type: 'string' },
            authorized: { type: 'boolean' }
        }, ['ownerId', 'memberName', 'caregiverName', 'signal', 'followupStatus', 'consentId', 'authorized'])
    }
];

function normalized(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function partitionKey(ownerId) {
    if (!ownerId) {
        throw new TypeError('ownerId is required.');
    }
    return `USER#${ownerId}`;
}

function timeframeStart(timeframe) {
    const duration = timeframe === 'today' ? 24 * 60 * 60 * 1000
        : timeframe === 'this month' ? 30 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() - duration).toISOString();
}

async function putRecord(item) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        await dynamoClient.send(new PutCommand({ TableName: tableName, Item: item }));
        return { ...item, source: 'dynamodb' };
    }
    const existingIndex = mockRecords.findIndex(record => record.pk === item.pk && record.sk === item.sk);
    if (existingIndex >= 0) {
        mockRecords[existingIndex] = item;
    } else {
        mockRecords.push(item);
    }
    return { ...item, source: 'mock' };
}

async function queryPrefix(pk, prefix, limit = 100) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        const result = await dynamoClient.send(new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
            ScanIndexForward: false,
            Limit: limit
        }));
        return result.Items || [];
    }
    return mockRecords
        .filter(record => record.pk === pk && record.sk.startsWith(prefix))
        .sort((left, right) => right.sk.localeCompare(left.sk))
        .slice(0, limit);
}

async function updateRecord(pk, sk, values) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        const names = {};
        const expressionValues = {};
        const assignments = Object.entries(values).map(([key, value], index) => {
            names[`#field${index}`] = key;
            expressionValues[`:value${index}`] = value;
            return `#field${index} = :value${index}`;
        });
        const result = await dynamoClient.send(new UpdateCommand({
            TableName: tableName,
            Key: { pk, sk },
            UpdateExpression: `SET ${assignments.join(', ')}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: expressionValues,
            ReturnValues: 'ALL_NEW'
        }));
        return result.Attributes;
    }
    const record = mockRecords.find(item => item.pk === pk && item.sk === sk);
    if (!record) {
        throw new Error(`Record not found: ${sk}`);
    }
    Object.assign(record, values);
    return { ...record };
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
        createdAt: new Date().toISOString()
    });
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
    const tableName = process.env.CARE_TABLE_NAME;
    let session;
    if (tableName) {
        const result = await dynamoClient.send(new GetCommand({
            TableName: tableName,
            Key: { pk, sk: 'SESSION' }
        }));
        session = result.Item;
    } else {
        session = mockRecords.find(record => record.pk === pk && record.sk === 'SESSION');
    }
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) {
        return null;
    }
    return session;
}

async function deleteMcpSession(sessionId) {
    const pk = `MCPSESSION#${sessionId}`;
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        await dynamoClient.send(new DeleteCommand({
            TableName: tableName,
            Key: { pk, sk: 'SESSION' }
        }));
    } else {
        const index = mockRecords.findIndex(record => record.pk === pk && record.sk === 'SESSION');
        if (index >= 0) {
            mockRecords.splice(index, 1);
        }
    }
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

function resetMockRecords() {
    mockRecords.length = 0;
}

module.exports = {
    MCP_TOOLS,
    callTool,
    getCareContext,
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
    resetMockRecords
};

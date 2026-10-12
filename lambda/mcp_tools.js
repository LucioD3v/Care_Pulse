'use strict';

function objectSchema(properties, required) {
    for (const [name, property] of Object.entries(properties)) {
        if (property.type === 'string') {
            property.minLength ??= name === 'details' ? 0 : 1;
            property.maxLength ??= name === 'details' ? 1000 : name === 'cursor' ? 2048 : 200;
        }
    }
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
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string' }
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
            dueDate: { type: 'string', format: 'date' },
            dueTime: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }
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
            followupStatus: { type: 'string', enum: ['same', 'worse'] },
            consentId: { type: 'string' },
            authorized: { type: 'boolean', const: true }
        }, ['ownerId', 'memberName', 'caregiverName', 'signal', 'followupStatus', 'consentId', 'authorized'])
    },
    {
        name: 'ingest_bee_context',
        description: 'Derive wellness signals from a consented Bee export. Requires the link code the member received when authorizing Bee in CarePulse. Only the wearer\'s own utterances and confirmed facts are analyzed; transcripts are never stored.',
        inputSchema: {
            type: 'object',
            properties: {
                linkCode: { type: 'string', minLength: 8, maxLength: 32, description: 'Code shown in the Alexa app after the member says "link my Bee".' },
                beeExport: {
                    type: 'object',
                    properties: {
                        exportedAt: { type: 'string', format: 'date-time' },
                        facts: {
                            type: 'array',
                            maxItems: 100,
                            items: {
                                type: 'object',
                                properties: { text: { type: 'string', maxLength: 10000 }, confirmed: { type: 'boolean' } },
                                required: ['text', 'confirmed'],
                                additionalProperties: false
                            }
                        },
                        conversations: {
                            type: 'array',
                            maxItems: 100,
                            items: {
                                type: 'object',
                                properties: {
                                    utterances: {
                                        type: 'array',
                                        maxItems: 500,
                                        items: {
                                            type: 'object',
                                            properties: {
                                                speaker: { type: 'string', enum: ['wearer', 'other'] },
                                                text: { type: 'string', maxLength: 10000 }
                                            },
                                            required: ['speaker', 'text'],
                                            additionalProperties: false
                                        }
                                    },
                                    summary: { type: 'string', maxLength: 10000 }
                                },
                                additionalProperties: false
                            }
                        },
                        healthKit: {
                            type: 'object',
                            properties: { sleepHours: { type: 'number', minimum: 0, maximum: 24 } },
                            additionalProperties: false
                        }
                    },
                    required: ['exportedAt'],
                    additionalProperties: false
                }
            },
            required: ['linkCode', 'beeExport'],
            additionalProperties: false
        }
    }
];

const text = { type: 'string' };
const number = { type: 'number' };
const nullableNumber = { type: ['number', 'null'] };
const period = objectSchema({
    timeframe: text, timezone: text, startDate: text, endDate: text,
    start: text, end: text, ruleVersion: text
}, ['timeframe', 'timezone', 'startDate', 'endDate', 'start', 'end', 'ruleVersion']);
const event = objectSchema({
    memberName: text, signal: text, state: text, details: { type: 'string', maxLength: 1000 },
    numericValue: number, recordedAt: text, provenance: text
}, ['memberName', 'signal', 'state', 'recordedAt']);
const outputs = {
    ingest_bee_context: objectSchema({
        success: { type: 'boolean' },
        eventsIngested: { type: 'integer', minimum: 0 },
        signalsDetected: { type: 'array', items: text },
        skipped: { type: 'integer', minimum: 0 },
        ignored: objectSchema({
            unconfirmedFacts: { type: 'integer', minimum: 0 },
            otherSpeakerUtterances: { type: 'integer', minimum: 0 }
        }, ['unconfirmedFacts', 'otherSpeakerUtterances']),
        errors: { type: 'array', items: objectSchema({
            signal: text, message: text
        }, ['signal', 'message']) }
    }, ['success', 'eventsIngested', 'signalsDetected', 'skipped', 'ignored', 'errors']),
    get_care_context: objectSchema({
        memberName: text, caregiverName: text, baselineSleepHours: nullableNumber, baselineSource: text, timezone: text,
        summaryLength: text, preferredFollowupTime: text, followupOffers: text
    }, ['memberName', 'caregiverName', 'baselineSleepHours', 'timezone']),
    log_wellness_event: event,
    get_wellness_history: objectSchema({
        events: { type: 'array', items: event }, period, nextCursor: { type: ['string', 'null'] }
    }, ['events', 'period', 'nextCursor']),
    compare_with_baseline: objectSchema({
        memberName: text, signal: text, repeatedCount: number, repeatedDays: number,
        averageSleep: nullableNumber, sleepDays: number, baselineSleepHours: nullableNumber,
        lessSleepThanRoutine: { type: 'boolean' }, changeObserved: { type: 'boolean' },
        observedDays: number, period, ruleVersion: text, summary: { type: 'string', maxLength: 1200 }
    }, ['memberName', 'signal', 'repeatedCount', 'repeatedDays', 'changeObserved', 'period', 'ruleVersion', 'summary']),
    create_followup: objectSchema({
        followupId: text, memberName: text, signal: text, dueDate: text, dueTime: text,
        dueAt: text, status: text
    }, ['followupId', 'memberName', 'signal', 'dueDate', 'dueTime', 'dueAt', 'status']),
    request_consent: objectSchema({
        consentId: text, memberName: text, caregiverName: text, signal: text,
        followupId: text, scope: text, status: text, grantedAt: text, expiresAt: { type: 'integer' }
    }, ['consentId', 'memberName', 'caregiverName', 'signal', 'followupId', 'status', 'expiresAt']),
    send_caregiver_alert: objectSchema({
        sent: { type: 'boolean' }, simulated: { type: 'boolean' }, status: text, messageId: text
    }, ['sent', 'simulated', 'status'])
};
for (const tool of MCP_TOOLS) {
    tool.outputSchema = outputs[tool.name];
    tool.annotations = {
        // Reads may initialize a missing care context.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: ['get_care_context', 'get_wellness_history', 'compare_with_baseline'].includes(tool.name),
        openWorldHint: tool.name === 'send_caregiver_alert'
    };
}

module.exports = { MCP_TOOLS };

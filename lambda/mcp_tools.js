'use strict';

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
    },
    {
        name: 'ingest_bee_context',
        description: 'Derive wellness signals from a consented Bee export. Requires the link code the member received when authorizing Bee in CarePulse. Only the wearer\'s own utterances and confirmed facts are analyzed; transcripts are never stored.',
        inputSchema: {
            type: 'object',
            properties: {
                linkCode: { type: 'string', description: 'Code shown in the Alexa app after the member says "link my Bee".' },
                beeExport: {
                    type: 'object',
                    properties: {
                        exportedAt: { type: 'string', format: 'date-time' },
                        facts: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { text: { type: 'string' }, confirmed: { type: 'boolean' } }
                            }
                        },
                        conversations: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    utterances: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                speaker: { type: 'string', enum: ['wearer', 'other'] },
                                                text: { type: 'string' }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        healthKit: {
                            type: 'object',
                            properties: { sleepHours: { type: 'number', minimum: 0, maximum: 24 } }
                        }
                    },
                    required: ['exportedAt']
                }
            },
            required: ['linkCode', 'beeExport'],
            additionalProperties: false
        }
    }
];

module.exports = { MCP_TOOLS };

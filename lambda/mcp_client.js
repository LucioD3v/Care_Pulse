'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { sendCaregiverAlert } = require('./sns_notifier');

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));
const mockHealthHistory = [];

const MCP_TOOLS = [
    {
        name: 'log_health_metric',
        description: 'Record a family member health measurement.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['blood pressure', 'temperature', 'heart rate', 'sleep'] },
                value: { type: ['number', 'string'] },
                unit: { type: 'string' },
                date: { type: 'string', format: 'date-time' },
                memberName: { type: 'string' }
            },
            required: ['type', 'value', 'unit', 'date', 'memberName'],
            additionalProperties: false
        }
    },
    {
        name: 'get_health_history',
        description: 'Retrieve recent health measurements for a family member.',
        inputSchema: {
            type: 'object',
            properties: {
                memberName: { type: 'string' },
                timeframe: { type: 'string', enum: ['today', 'this week', 'this month'] },
                limit: { type: 'integer', minimum: 1, maximum: 100 }
            },
            required: ['memberName'],
            additionalProperties: false
        }
    },
    {
        name: 'analyze_health_trends',
        description: 'Analyze recent measurements for changes and repeated patterns without making a diagnosis.',
        inputSchema: {
            type: 'object',
            properties: {
                memberName: { type: 'string' },
                timeframe: { type: 'string' },
                history: { type: 'array', items: { type: 'object' } }
            },
            required: ['memberName', 'history'],
            additionalProperties: false
        }
    },
    {
        name: 'trigger_caregiver_alert',
        description: 'Send a structured caregiver notification using the configured SNS topic.',
        inputSchema: {
            type: 'object',
            properties: {
                memberName: { type: 'string' },
                metric: { type: 'string' },
                value: { type: ['number', 'string'] },
                unit: { type: 'string' },
                message: { type: 'string' }
            },
            required: ['memberName'],
            additionalProperties: false
        }
    }
];

function timeframeStart(timeframe) {
    const now = Date.now();
    const duration = timeframe === 'today' ? 24 * 60 * 60 * 1000
        : timeframe === 'this month' ? 30 * 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000;
    return new Date(now - duration).toISOString();
}

async function logHealthMetric(input) {
    if (!input || !input.memberName || !input.type || input.value === undefined) {
        throw new TypeError('memberName, type, and value are required to log a health metric.');
    }
    const item = {
        memberName: String(input.memberName),
        timestamp: `${input.date || new Date().toISOString()}#${randomUUID()}`,
        type: String(input.type),
        value: input.value,
        unit: String(input.unit || ''),
        recordedAt: new Date().toISOString()
    };
    const tableName = process.env.HEALTH_TABLE_NAME;
    if (tableName) {
        try {
            await dynamoClient.send(new PutCommand({ TableName: tableName, Item: item }));
            return { ...item, stored: true, source: 'dynamodb' };
        } catch (error) {
            console.warn('DynamoDB write failed; saving to the local mock history:', error.message);
        }
    }
    mockHealthHistory.push(item);
    return { ...item, stored: true, source: 'mock' };
}

async function getHealthHistory({ memberName, timeframe = 'this week', limit = 100 } = {}) {
    if (!memberName) {
        throw new TypeError('memberName is required to retrieve health history.');
    }
    const start = timeframeStart(timeframe);
    const tableName = process.env.HEALTH_TABLE_NAME;
    if (tableName) {
        try {
            const result = await dynamoClient.send(new QueryCommand({
                TableName: tableName,
                KeyConditionExpression: 'memberName = :memberName AND #timestamp >= :start',
                ExpressionAttributeNames: { '#timestamp': 'timestamp' },
                ExpressionAttributeValues: { ':memberName': String(memberName), ':start': start },
                ScanIndexForward: false,
                Limit: limit
            }));
            return result.Items || [];
        } catch (error) {
            console.warn('DynamoDB query failed; reading from the local mock history:', error.message);
        }
    }
    return mockHealthHistory
        .filter(item => item.memberName.toLowerCase() === String(memberName).toLowerCase() && item.timestamp >= start)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
}

async function analyzeHealthTrends({ memberName, timeframe = 'this week', history = [] } = {}) {
    const grouped = history.reduce((accumulator, item) => {
        const entries = accumulator[item.type] || (accumulator[item.type] = []);
        entries.push(item);
        return accumulator;
    }, {});
    const observations = [];
    for (const [type, entries] of Object.entries(grouped)) {
        const values = entries.map(item => Number(item.value)).filter(Number.isFinite);
        if (values.length >= 2) {
            const change = values[0] - values[values.length - 1];
            const direction = change > 0 ? 'increased' : change < 0 ? 'decreased' : 'remained steady';
            observations.push(`${type} ${direction} across ${values.length} readings`);
        } else if (values.length === 1) {
            observations.push(`one ${type} reading was recorded`);
        }
    }
    return observations.map(observation => `${memberName}'s ${observation} ${timeframe}`);
}

async function triggerCaregiverAlert(input) {
    return sendCaregiverAlert(input);
}

async function callTool(name, input) {
    const handlers = {
        log_health_metric: logHealthMetric,
        get_health_history: getHealthHistory,
        analyze_health_trends: analyzeHealthTrends,
        trigger_caregiver_alert: triggerCaregiverAlert
    };
    if (!handlers[name]) {
        throw new Error(`Unknown MCP tool: ${name}`);
    }
    return handlers[name](input);
}

module.exports = {
    MCP_TOOLS,
    callTool,
    logHealthMetric,
    getHealthHistory,
    analyzeHealthTrends,
    triggerCaregiverAlert
};
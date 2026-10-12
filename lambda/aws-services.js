'use strict';

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { sendWithBudget } = require('./observability');

function clientOptions() {
    const endpoint = process.env.LOCALSTACK_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const options = {
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
    };

    if (endpoint) {
        options.endpoint = endpoint;
        options.credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test'
        };
    }

    return options;
}

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({ ...clientOptions(), maxAttempts: 2 }), { marshallOptions: { removeUndefinedValues: true } });
const sns = new SNSClient({ ...clientOptions(), maxAttempts: 1 });

function requireEnvironment(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function anonymizeUserId(userId) {
    return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

async function saveVital({ userId, requestId, metric, value, diastolic, unit }) {
    const recordedAt = new Date().toISOString();
    const item = {
        UserId: userId,
        RecordId: `${recordedAt}#${requestId}`,
        RecordedAt: recordedAt,
        Metric: metric,
        Value: value,
        Unit: unit
    };

    if (diastolic !== undefined) {
        item.Diastolic = diastolic;
    }

    await sendWithBudget(dynamodb, new PutCommand({
        TableName: requireEnvironment('VITALS_TABLE_NAME'),
        Item: item,
        ConditionExpression: 'attribute_not_exists(UserId) AND attribute_not_exists(RecordId)'
    }));

    return item;
}

async function getVitals({ userId, since, until = new Date(), limit = 100 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be between 1 and 1000.');
    const items = [];
    let cursor;
    do {
        const result = await sendWithBudget(dynamodb, new QueryCommand({
            TableName: requireEnvironment('VITALS_TABLE_NAME'),
            KeyConditionExpression: 'UserId = :userId AND RecordId BETWEEN :from AND :to',
            ExpressionAttributeValues: {
                ':userId': userId, ':from': since.toISOString() + '#', ':to': until.toISOString() + '#\uffff'
            },
            ConsistentRead: true, ScanIndexForward: false,
            Limit: limit - items.length,
            ...(cursor ? { ExclusiveStartKey: cursor } : {})
        }));
        items.push(...(result.Items || []));
        cursor = result.LastEvaluatedKey;
    } while (cursor && items.length < limit);
    return items;
}

async function sendCaregiverAlert({ userId, severity, message, requestId }) {
    const sentAt = new Date().toISOString();
    const payload = {
        type: 'CAREGIVER_ALERT',
        userReference: anonymizeUserId(userId),
        severity,
        message,
        requestId,
        sentAt
    };

    const result = await sendWithBudget(sns, new PublishCommand({
        TopicArn: requireEnvironment('CAREGIVER_TOPIC_ARN'),
        Subject: `CarePulse ${severity} caregiver alert`,
        Message: JSON.stringify(payload)
    }));

    return { messageId: result.MessageId, ...payload };
}

module.exports = {
    anonymizeUserId,
    getVitals,
    saveVital,
    sendCaregiverAlert
};

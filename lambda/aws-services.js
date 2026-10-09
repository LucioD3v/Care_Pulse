'use strict';

const crypto = require('crypto');
const AWS = require('aws-sdk');

function clientOptions() {
    const endpoint = process.env.LOCALSTACK_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const options = {
        region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
    };

    if (endpoint) {
        options.endpoint = endpoint;
        options.sslEnabled = endpoint.startsWith('https://');
        options.accessKeyId = process.env.AWS_ACCESS_KEY_ID || 'test';
        options.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || 'test';
    }

    return options;
}

const dynamodb = new AWS.DynamoDB.DocumentClient(clientOptions());
const sns = new AWS.SNS(clientOptions());

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

    await dynamodb.put({
        TableName: requireEnvironment('VITALS_TABLE_NAME'),
        Item: item,
        ConditionExpression: 'attribute_not_exists(UserId) AND attribute_not_exists(RecordId)'
    }).promise();

    return item;
}

async function getVitals({ userId, since, until = new Date(), limit = 100 }) {
    const result = await dynamodb.query({
        TableName: requireEnvironment('VITALS_TABLE_NAME'),
        KeyConditionExpression: 'UserId = :userId AND RecordId BETWEEN :from AND :to',
        ExpressionAttributeValues: {
            ':userId': userId,
            ':from': `${since.toISOString()}#`,
            ':to': `${until.toISOString()}#\uffff`
        },
        ScanIndexForward: false,
        Limit: limit
    }).promise();

    return result.Items || [];
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

    const result = await sns.publish({
        TopicArn: requireEnvironment('CAREGIVER_TOPIC_ARN'),
        Subject: `CarePulse ${severity} caregiver alert`,
        Message: JSON.stringify(payload)
    }).promise();

    return { messageId: result.MessageId, ...payload };
}

module.exports = {
    anonymizeUserId,
    getVitals,
    saveVital,
    sendCaregiverAlert
};

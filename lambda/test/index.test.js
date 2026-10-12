'use strict';

const assert = require('node:assert/strict');
const { test, beforeEach, afterEach, mock } = require('node:test');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { SNSClient } = require('@aws-sdk/client-sns');
const services = require('../aws-services');

beforeEach(() => {
    process.env.VITALS_TABLE_NAME = 'test-vitals';
    process.env.CAREGIVER_TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:test-alerts';
});
afterEach(() => {
    mock.restoreAll();
    delete process.env.VITALS_TABLE_NAME;
    delete process.env.CAREGIVER_TOPIC_ARN;
});

test('the vitals adapter uses SDK v3 and preserves conditional writes', async () => {
    let command;
    mock.method(DynamoDBDocumentClient.prototype, 'send', async input => { command = input; return {}; });
    const result = await services.saveVital({ userId: 'u', requestId: 'r', metric: 'heart rate', value: 70, unit: 'bpm' });
    assert.equal(command.constructor.name, 'PutCommand');
    assert.match(command.input.ConditionExpression, /attribute_not_exists/);
    assert.equal(command.input.TableName, 'test-vitals');
    assert.equal(result.Value, 70);
});

test('the vitals adapter uses a consistent bounded query', async () => {
    let command;
    mock.method(DynamoDBDocumentClient.prototype, 'send', async input => {
        command = input;
        return { Items: [{ Value: 70 }] };
    });
    const items = await services.getVitals({ userId: 'u', since: new Date('2026-01-01'), limit: 10 });
    assert.equal(command.constructor.name, 'QueryCommand');
    assert.equal(command.input.ConsistentRead, true);
    assert.equal(command.input.Limit, 10);
    assert.deepEqual(items, [{ Value: 70 }]);
});

test('the vitals notification adapter retains its public result contract', async () => {
    let command;
    mock.method(SNSClient.prototype, 'send', async input => { command = input; return { MessageId: 'message-1' }; });
    const result = await services.sendCaregiverAlert({ userId: 'private-user', severity: 'normal', message: 'Check in', requestId: 'r' });
    assert.equal(command.constructor.name, 'PublishCommand');
    assert.equal(result.messageId, 'message-1');
    assert.equal(JSON.parse(command.input.Message).userReference, services.anonymizeUserId('private-user'));
    assert.doesNotMatch(command.input.Message, /private-user/);
});

test('Lambda entry points can load with production dependencies', () => {
    for (const file of ['index', 'mcp_http', 'followup_monitor']) assert.equal(typeof require('../' + file).handler, 'function');
});

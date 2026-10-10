'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1'
}));
const mockRecords = [];

function partitionKey(ownerId) {
    if (!ownerId) {
        throw new TypeError('ownerId is required.');
    }
    return `USER#${ownerId}`;
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

async function putRecordIfAbsent(item) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        try {
            await dynamoClient.send(new PutCommand({
                TableName: tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(sk)'
            }));
            return true;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') {
                return false;
            }
            throw error;
        }
    }
    if (mockRecords.some(record => record.pk === item.pk && record.sk === item.sk)) {
        return false;
    }
    mockRecords.push(item);
    return true;
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

async function queryAllPrefix(pk, prefix) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (!tableName) {
        return mockRecords.filter(record => record.pk === pk && record.sk.startsWith(prefix));
    }
    const items = [];
    let exclusiveStartKey;
    do {
        const result = await dynamoClient.send(new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
            ExclusiveStartKey: exclusiveStartKey
        }));
        items.push(...(result.Items || []));
        exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
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

async function getRecord(pk, sk) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        const result = await dynamoClient.send(new GetCommand({
            TableName: tableName,
            Key: { pk, sk }
        }));
        return result.Item || null;
    }
    return mockRecords.find(record => record.pk === pk && record.sk === sk) || null;
}

async function deleteRecord(pk, sk) {
    const tableName = process.env.CARE_TABLE_NAME;
    if (tableName) {
        await dynamoClient.send(new DeleteCommand({
            TableName: tableName,
            Key: { pk, sk }
        }));
        return;
    }
    const index = mockRecords.findIndex(record => record.pk === pk && record.sk === sk);
    if (index >= 0) {
        mockRecords.splice(index, 1);
    }
}

function resetMockRecords() {
    mockRecords.length = 0;
}

module.exports = {
    partitionKey,
    putRecord,
    putRecordIfAbsent,
    queryPrefix,
    queryAllPrefix,
    updateRecord,
    getRecord,
    deleteRecord,
    resetMockRecords
};

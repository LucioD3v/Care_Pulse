'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand, DeleteCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { sendWithBudget } = require('./observability');

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 2
}), { marshallOptions: { removeUndefinedValues: true } });
const mockRecords = new Map();
const keyOf = (pk, sk) => JSON.stringify([pk, sk]);

function partitionKey(ownerId) {
    if (!ownerId) throw new TypeError('ownerId is required.');
    return 'USER#' + ownerId;
}

async function putRecord(item) {
    if (process.env.CARE_TABLE_NAME) {
        await sendWithBudget(dynamoClient, new PutCommand({ TableName: process.env.CARE_TABLE_NAME, Item: item }));
    } else {
        mockRecords.set(keyOf(item.pk, item.sk), structuredClone(item));
    }
    return { ...item, source: process.env.CARE_TABLE_NAME ? 'dynamodb' : 'mock' };
}

async function putRecordIfAbsent(item) {
    if (process.env.CARE_TABLE_NAME) {
        try {
            await sendWithBudget(dynamoClient, new PutCommand({
                TableName: process.env.CARE_TABLE_NAME, Item: item,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
            }));
            return true;
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') return false;
            throw error;
        }
    }
    const key = keyOf(item.pk, item.sk);
    if (mockRecords.has(key)) return false;
    mockRecords.set(key, structuredClone(item));
    return true;
}

async function queryAllPrefix(pk, prefix) {
    return queryPrefix(pk, prefix);
}

async function putRecords(items) {
    if (process.env.CARE_TABLE_NAME) {
        await sendWithBudget(dynamoClient, new TransactWriteCommand({
            TransactItems: items.map(Item => ({ Put: { TableName: process.env.CARE_TABLE_NAME, Item } }))
        }));
    } else {
        items.forEach(item => mockRecords.set(keyOf(item.pk, item.sk), structuredClone(item)));
    }
}

async function queryPage(pk, prefix, { limit = 100, cursor, ascending = false, from, to, indexName } = {}) {
    const pkName = indexName ? 'pendingPartition' : 'pk';
    const skName = indexName ? 'dueAt' : 'sk';
    if (process.env.CARE_TABLE_NAME) {
        const range = from !== undefined && to !== undefined;
        const result = await sendWithBudget(dynamoClient, new QueryCommand({
            TableName: process.env.CARE_TABLE_NAME,
            ...(indexName ? { IndexName: indexName } : { ConsistentRead: true }),
            KeyConditionExpression: '#pk = :pk AND ' + (range ? '#sk BETWEEN :from AND :to' : 'begins_with(#sk, :prefix)'),
            ExpressionAttributeNames: { '#pk': pkName, '#sk': skName },
            ExpressionAttributeValues: { ':pk': pk, ...(range ? { ':from': from, ':to': to } : { ':prefix': prefix }) },
            ScanIndexForward: ascending, Limit: limit,
            ...(cursor ? { ExclusiveStartKey: cursor } : {})
        }));
        return { items: result.Items || [], cursor: result.LastEvaluatedKey || null };
    }
    const records = [...mockRecords.values()].filter(record => record[pkName] === pk
        && (from !== undefined ? record[skName] >= from && record[skName] <= to : record[skName].startsWith(prefix)))
        .sort((a, b) => (a[skName] < b[skName] ? -1 : a[skName] > b[skName] ? 1 : 0) * (ascending ? 1 : -1));
    const offset = cursor ? records.findIndex(record => record.pk === cursor.pk && record.sk === cursor.sk) + 1 : 0;
    const items = records.slice(offset, offset + limit);
    const last = items.at(-1);
    return {
        items: structuredClone(items),
        cursor: offset + limit < records.length ? { pk: last.pk, sk: last.sk } : null
    };
}

async function queryPrefix(pk, prefix, limit = Infinity, options = {}) {
    const records = [];
    let cursor;
    do {
        const page = await queryPage(pk, prefix, { ...options, cursor, limit: Math.min(100, limit - records.length) });
        records.push(...page.items);
        cursor = page.cursor;
    } while (cursor && records.length < limit);
    return records;
}

async function updateRecord(pk, sk, values, remove = []) {
    if (process.env.CARE_TABLE_NAME) {
        const names = {};
        const expressionValues = {};
        const assignments = Object.entries(values).map(([key, value], index) => {
            names['#field' + index] = key;
            expressionValues[':value' + index] = value;
            return '#field' + index + ' = :value' + index;
        });
        remove.forEach((key, index) => { names['#remove' + index] = key; });
        const result = await sendWithBudget(dynamoClient, new UpdateCommand({
            TableName: process.env.CARE_TABLE_NAME, Key: { pk, sk },
            ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
            UpdateExpression: 'SET ' + assignments.join(', ') + (remove.length ? ' REMOVE ' + remove.map((_, index) => '#remove' + index).join(', ') : ''),
            ExpressionAttributeNames: names, ExpressionAttributeValues: expressionValues,
            ReturnValues: 'ALL_NEW'
        }));
        return result.Attributes;
    }
    const record = mockRecords.get(keyOf(pk, sk));
    if (!record) throw new Error('Record not found.');
    Object.assign(record, values);
    remove.forEach(key => { delete record[key]; });
    return structuredClone(record);
}

async function getRecord(pk, sk) {
    if (process.env.CARE_TABLE_NAME) {
        const result = await sendWithBudget(dynamoClient, new GetCommand({
            TableName: process.env.CARE_TABLE_NAME, Key: { pk, sk }, ConsistentRead: true
        }));
        return result.Item || null;
    }
    return structuredClone(mockRecords.get(keyOf(pk, sk)) || null);
}

async function deleteRecord(pk, sk) {
    if (process.env.CARE_TABLE_NAME) {
        await sendWithBudget(dynamoClient, new DeleteCommand({ TableName: process.env.CARE_TABLE_NAME, Key: { pk, sk } }));
    } else {
        mockRecords.delete(keyOf(pk, sk));
    }
}

function resetMockRecords() { mockRecords.clear(); }

module.exports = { partitionKey, putRecordIfAbsent, queryAllPrefix, putRecord, putRecords, queryPage, queryPrefix, updateRecord, getRecord, deleteRecord, resetMockRecords };

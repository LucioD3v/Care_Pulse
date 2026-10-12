'use strict';

const { createHash } = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { followupInstant, DEFAULT_TIME_ZONE } = require('./care_periods');

async function main() {
    const TableName = process.env.CARE_TABLE_NAME;
    if (!TableName) throw new Error('CARE_TABLE_NAME is required.');
    const apply = process.argv.includes('--apply');
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
    let cursor;
    let candidates = 0;
    let updated = 0;
    do {
        const page = await client.send(new ScanCommand({
            TableName, ExclusiveStartKey: cursor, ConsistentRead: true,
            FilterExpression: 'entityType = :type AND #status = :pending AND attribute_not_exists(pendingPartition)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':type': 'FOLLOWUP', ':pending': 'pending' }
        }));
        for (const record of page.Items || []) {
            candidates += 1;
            if (!apply) continue;
            const memberKey = record.memberName.trim().toLowerCase().replace(/\s+/g, '-');
            const context = await client.send(new GetCommand({
                TableName, Key: { pk: record.pk, sk: 'CONTEXT#' + memberKey }, ConsistentRead: true
            }));
            const timezone = context.Item?.timezone || process.env.DEFAULT_TIME_ZONE || DEFAULT_TIME_ZONE;
            const dueAt = followupInstant(record.dueDate, record.dueTime, timezone);
            const pendingPartition = 'PENDING#' + (createHash('sha256').update(record.pk).digest()[0] % 16);
            try {
                await client.send(new TransactWriteCommand({ TransactItems: [
                    { Update: {
                        TableName, Key: { pk: record.pk, sk: record.sk },
                        UpdateExpression: 'SET pendingPartition = :partition, dueAt = :due',
                        ConditionExpression: '#status = :pending AND attribute_not_exists(pendingPartition)',
                        ExpressionAttributeNames: { '#status': 'status' },
                        ExpressionAttributeValues: { ':partition': pendingPartition, ':due': dueAt, ':pending': 'pending' }
                    } },
                    { Put: { TableName, Item: {
                        pk: record.pk, sk: 'FOLLOWUP_ID#' + record.followupId,
                        entityType: 'FOLLOWUP_REFERENCE', memberName: record.memberName, followupSk: record.sk
                    } } }
                ] }));
                updated += 1;
            } catch (error) {
                if (error.name !== 'TransactionCanceledException'
                    || !error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')) throw error;
            }
        }
        cursor = page.LastEvaluatedKey;
    } while (cursor);
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidates, updated }));
}

if (require.main === module) main().catch(() => {
    console.error('Follow-up index backfill failed. No record contents were logged.');
    process.exitCode = 1;
});

module.exports = { main };

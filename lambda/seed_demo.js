'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const tableName = process.env.CARE_TABLE_NAME;
const ownerId = process.env.DEMO_OWNER_ID || 'hackathon-demo';
const region = process.env.AWS_REGION || 'us-east-1';

if (!tableName) {
    throw new Error('Set CARE_TABLE_NAME to the deployed CarePulse DynamoDB table before seeding.');
}

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const pk = `USER#${ownerId}`;
const memberName = process.env.DEFAULT_MEMBER_NAME || 'Elena';
const memberKey = memberName.toLowerCase().replace(/\s+/g, '-');
const now = Date.now();

function isoDaysAgo(days, hour) {
    const date = new Date(now - days * 24 * 60 * 60 * 1000);
    date.setUTCHours(hour, 0, 0, 0);
    return date.toISOString();
}

const events = [
    { signal: 'tiredness', state: 'more-than-usual', recordedAt: isoDaysAgo(3, 15) },
    { signal: 'tiredness', state: 'more-than-usual', recordedAt: isoDaysAgo(1, 16) },
    { signal: 'sleep', state: 'reported', numericValue: 5.5, recordedAt: isoDaysAgo(3, 8) },
    { signal: 'sleep', state: 'reported', numericValue: 6, recordedAt: isoDaysAgo(2, 8) },
    { signal: 'sleep', state: 'reported', numericValue: 5.8, recordedAt: isoDaysAgo(1, 8) }
];

async function put(Item) {
    await client.send(new PutCommand({ TableName: tableName, Item }));
}

async function main() {
    await put({
        pk,
        sk: `CONTEXT#${memberKey}`,
        entityType: 'CARE_CONTEXT',
        memberName,
        caregiverName: process.env.DEFAULT_CAREGIVER_NAME || 'Laura',
        baselineSleepHours: 7.5,
        timezone: process.env.DEFAULT_TIME_ZONE || 'America/Mexico_City',
        createdAt: new Date().toISOString()
    });
    await Promise.all(events.map((event, index) => put({
        pk,
        sk: `EVENT#${memberKey}#${event.recordedAt}#seed-${index}`,
        entityType: 'WELLNESS_EVENT',
        memberName,
        ...event,
        provenance: 'demo-seed'
    })));
    console.log(`Seeded CarePulse demo context for ${memberName} in ${tableName} using owner ${ownerId}.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

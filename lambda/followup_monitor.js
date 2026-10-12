'use strict';

const { queryPrefix, getRecord } = require('./care_repository');
const { metric, withRequest } = require('./observability');

exports.handler = (_event, context) => withRequest('monitor', context, 50000, async () => {
    const now = new Date();
    let count = 0;
    let oldestAge = 0;
    for (let shard = 0; shard < 16; shard += 1) {
        const records = await queryPrefix('PENDING#' + shard, '', Infinity, {
            indexName: 'PendingFollowups', from: '0000', to: now.toISOString(), ascending: true
        });
        for (const reference of records) {
            // GSI reads are eventual; confirm each candidate against the base table.
            const record = await getRecord(reference.pk, reference.sk);
            if (record?.status !== 'pending' || !record.dueAt || record.dueAt > now.toISOString()) continue;
            count += 1;
            oldestAge = Math.max(oldestAge, Math.floor((now - new Date(record.dueAt)) / 1000));
        }
    }
    metric('OverdueFollowups', count);
    metric('OldestOverdueAge', oldestAge, 'Seconds');
    return { count };
});

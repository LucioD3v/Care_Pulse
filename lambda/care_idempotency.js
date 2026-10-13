'use strict';

const { createHash } = require('node:crypto');
const { currentPrincipal } = require('./access_control');
const { commit, getRecord, isConflict } = require('./care_repository');
const { retentionSeconds } = require('./runtime_config');

async function saveOperation(pk, kind, input, records) {
    const requestId = currentPrincipal()?.requestId;
    if (!requestId) {
        await commit({ puts: records.map(item => ({ item, absent: true })) });
        return records[0];
    }
    const hash = value => createHash('sha256').update(value).digest('hex');
    const sk = 'OPERATION#' + hash(kind + ':' + requestId);
    const fingerprint = hash(JSON.stringify(input));
    const previous = await getRecord(pk, sk);
    const replay = async record => {
        if (!record || record.fingerprint !== fingerprint) throw new TypeError('Request identifier was reused with different arguments.');
        const result = await getRecord(pk, record.resultSk);
        if (!result) throw new Error('The original operation result is no longer available.');
        return result;
    };
    if (previous) return replay(previous);
    try {
        await commit({ puts: [
            ...records.map(item => ({ item, absent: true })),
            { item: { pk, sk, fingerprint, resultSk: records[0].sk,
                expiresAt: Math.floor(Date.now() / 1000) + retentionSeconds() }, absent: true }
        ] });
        return records[0];
    } catch (error) {
        if (!isConflict(error)) throw error;
        return replay(await getRecord(pk, sk));
    }
}

module.exports = { saveOperation };

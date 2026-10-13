'use strict';

process.env.ALEXA_SKILL_ID = 'expected-skill';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../index');
const { queryPrefix, resetMockRecords } = require('../care_repository');
const { createHash } = require('node:crypto');

test('a different Skill ID cannot reach the business handlers', async () => {
    mock.method(console, 'info', () => {});
    resetMockRecords();
    const result = await handler({
        version: '1.0', session: { application: { applicationId: 'wrong-skill' }, user: { userId: 'test-user' } },
        context: { System: { application: { applicationId: 'wrong-skill' }, user: { userId: 'test-user' } } },
        request: { type: 'LaunchRequest', requestId: 'r', locale: 'en-US', timestamp: new Date().toISOString() }
    }, {}).catch(() => null);
    const owner = createHash('sha256').update('test-user').digest('hex').slice(0, 32);
    assert.equal((await queryPrefix('USER#' + owner, '')).length, 0);
    if (result) assert.doesNotMatch(result.response.outputSpeech.ssml || result.response.outputSpeech.text, /Welcome to CarePulse/);
    mock.restoreAll();
});

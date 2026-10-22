'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const {
    DOCUMENT_TOKEN,
    followupCompletionDirective
} = require('../followup_completion_presentation');

afterEach(() => {
    delete process.env.CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL;
    delete process.env.CAREPULSE_REPORT_BACKGROUND_URL;
});

test('completion screen uses the dedicated background and compact status hierarchy', () => {
    process.env.CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL = 'https://assets.example.test/completed.png';
    const directive = followupCompletionDirective({
        memberName: 'Elena',
        status: 'same',
        alertStatus: 'No alert needed'
    });
    assert.equal(directive.token, DOCUMENT_TOKEN);
    assert.equal(directive.datasources.completionData.backgroundImageUrl,
        'https://assets.example.test/completed.png');
    assert.equal(directive.datasources.completionData.statusLabel, 'Feeling the same');
    assert.equal(directive.datasources.completionData.showDetails, true);
    const rendered = JSON.stringify(directive.document);
    assert.match(rendered, /Check-in complete/);
    assert.match(rendered, /Care Circle/);
    assert.match(rendered, /'30dp' : '44dp'/);
});

test('discreet completion screen omits member, status, and alert details', () => {
    process.env.CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL = 'https://assets.example.test/completed.png';
    const data = followupCompletionDirective({
        memberName: 'Elena',
        status: 'worse',
        alertStatus: 'Notification service accepted the alert for Laura',
        discreetMode: 'on'
    }).datasources.completionData;
    assert.equal(data.showDetails, false);
    assert.equal(data.message, 'Thank you. Your check-in is saved.');
    assert.equal(data.statusLabel, '');
    assert.equal(data.alertStatus, '');
    assert.doesNotMatch(JSON.stringify(data), /Elena|Laura|worse/i);
});

'use strict';

const assert = require('node:assert/strict');
const { beforeEach, afterEach, test, mock } = require('node:test');
const care = require('../care_service');
const { handler } = require('../index');
const { DOCUMENT_TOKEN } = require('../due_followup_presentation');
const { DOCUMENT_TOKEN: COMPLETION_TOKEN } = require('../followup_completion_presentation');

const OWNER_ID = 'due-followup-apl-owner';
const COVER_URL = 'https://assets.example.test/carepulse-cover.png';
const BACKGROUND_URL = 'https://assets.example.test/carepulse-report-background.png';
const COMPLETION_BACKGROUND_URL = 'https://assets.example.test/carepulse-followup-complete-background.png';

beforeEach(() => {
    care.resetMockRecords();
    process.env.CARE_MODE = 'demo';
    process.env.CARE_STORAGE_MODE = 'memory';
    process.env.DEMO_OWNER_ID = OWNER_ID;
    process.env.CAREPULSE_COVER_IMAGE_URL = COVER_URL;
    process.env.CAREPULSE_REPORT_BACKGROUND_URL = BACKGROUND_URL;
    process.env.CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL = COMPLETION_BACKGROUND_URL;
    mock.method(console, 'info', () => {});
});

afterEach(() => {
    for (const name of ['CARE_MODE', 'CARE_STORAGE_MODE', 'DEMO_OWNER_ID', 'CAREPULSE_COVER_IMAGE_URL', 'CAREPULSE_REPORT_BACKGROUND_URL',
        'CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL']) {
        delete process.env[name];
    }
    mock.restoreAll();
});

function launchRequest(screen = true) {
    const userId = 'due-followup-screen-user';
    return {
        version: '1.0',
        session: { new: true, sessionId: 'due-followup-session', application: { applicationId: 'test' },
            user: { userId }, attributes: {} },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {} } } },
        request: {
            type: 'LaunchRequest',
            requestId: 'due-followup-launch',
            timestamp: '2030-01-10T23:00:00Z',
            locale: 'en-US'
        }
    };
}

function userEvent(attributes, status) {
    const userId = 'due-followup-screen-user';
    return {
        version: '1.0',
        session: { new: false, sessionId: 'due-followup-session', application: { applicationId: 'test' },
            user: { userId }, attributes },
        context: { System: { application: { applicationId: 'test' }, user: { userId },
            device: { deviceId: 'screen', supportedInterfaces: { 'Alexa.Presentation.APL': {} } } } },
        request: {
            type: 'Alexa.Presentation.APL.UserEvent',
            requestId: `due-followup-${status}`,
            timestamp: '2030-01-10T23:00:05Z',
            locale: 'en-US',
            token: DOCUMENT_TOKEN,
            arguments: ['complete-due-followup', status],
            components: {}
        }
    };
}

async function createDueFollowup() {
    return care.createFollowup({
        ownerId: OWNER_ID,
        memberName: 'Elena',
        signal: 'tiredness',
        dueDate: '2030-01-10',
        dueTime: '16:00'
    });
}

test('due launch shows the cover for five seconds and transitions to the follow-up controls', async () => {
    await createDueFollowup();
    const result = await handler(launchRequest(), {});
    const directive = result.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.token, DOCUMENT_TOKEN);
    assert.equal(directive.datasources.followupData.coverImageUrl, COVER_URL);
    assert.equal(directive.datasources.followupData.backgroundImageUrl, BACKGROUND_URL);
    assert.equal(directive.datasources.followupData.question,
        'Elena, we planned to check how you were feeling. Do you feel better, the same, or worse?');
    const pager = directive.document.mainTemplate.items[0];
    assert.equal(pager.type, 'Pager');
    assert.equal(pager.items.length, 2);
    assert.deepEqual(pager.onMount[0], {
        type: 'AutoPage', componentId: 'dueFollowupPager', count: 1, delay: 5000, duration: 0, screenLock: true
    });
    const rendered = JSON.stringify(pager.items[1]);
    for (const status of ['better', 'same', 'worse']) {
        assert.match(rendered, new RegExp(`complete-due-followup.*${status}`));
    }
    assert.match(result.response.outputSpeech.ssml, /feel better, the same, or worse/i);
});

test('voice-only due launch keeps the question and does not send APL', async () => {
    await createDueFollowup();
    const result = await handler(launchRequest(false), {});
    assert.equal(result.response.directives?.length || 0, 0);
    assert.match(result.response.outputSpeech.ssml, /feel better, the same, or worse/i);
});

test('tapping Better completes the exact due follow-up and continues the conversation', async () => {
    const followup = await createDueFollowup();
    const launch = await handler(launchRequest(), {});
    const completed = await handler(userEvent(launch.sessionAttributes, 'better'), {});
    assert.match(completed.response.outputSpeech.ssml, /feel better/i);
    assert.match(completed.response.outputSpeech.ssml, /No caregiver alert was needed/i);
    const directive = completed.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.token, COMPLETION_TOKEN);
    assert.equal(directive.datasources.completionData.backgroundImageUrl, COMPLETION_BACKGROUND_URL);
    assert.equal(directive.datasources.completionData.message, 'Thank you, Elena. Your response is saved.');
    assert.equal(directive.datasources.completionData.statusLabel, 'Feeling better');
    assert.equal(directive.datasources.completionData.alertStatus, 'No alert needed');
    assert.match(JSON.stringify(directive.document), /Check-in complete/);
    assert.match(JSON.stringify(directive.document), /'30dp' : '44dp'/);
    const stored = await care.getFollowupById({
        ownerId: OWNER_ID,
        memberName: 'Elena',
        followupId: followup.followupId
    });
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result, 'better');
});

test('a stale or forged due-follow-up button cannot complete anything', async () => {
    const followup = await createDueFollowup();
    const launch = await handler(launchRequest(), {});
    const rejected = await handler(userEvent(launch.sessionAttributes, 'excellent'), {});
    assert.match(rejected.response.outputSpeech.ssml, /no longer available/i);
    const stored = await care.getFollowupById({
        ownerId: OWNER_ID,
        memberName: 'Elena',
        followupId: followup.followupId
    });
    assert.equal(stored.status, 'pending');
});

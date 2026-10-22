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

const { COPY } = require('../voice_copy');

const PERSONALIZED_QUESTION = 'Elena, we planned to check how you were feeling. Do you feel better, the same, or worse?';

// Property 1: Bug Condition - Discreet Mode Screen/Card Leak (Requirements 1.1, 1.2, 1.3)
test('discreet mode redacts the due follow-up screen and card while keeping speech personalized', async () => {
    await care.updateCarePreferences({ ownerId: OWNER_ID, memberName: 'Elena', discreetMode: 'on' });
    await createDueFollowup();
    const result = await handler(launchRequest(), {});

    const directive = result.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive, 'expected an APL RenderDocument directive');
    assert.equal(directive.token, DOCUMENT_TOKEN);

    // 1.1 APL datasource question must be redacted (no personalized member name).
    const screenQuestion = directive.datasources.followupData.question;
    assert.doesNotMatch(screenQuestion, /Elena/, 'APL question must not contain the personalized member name in discreet mode');

    // 1.2 app card body must be redacted.
    const card = result.response.card;
    assert.ok(card, 'expected an Alexa app card');
    const cardBody = card.content || card.text;
    assert.doesNotMatch(cardBody, /Elena/, 'card body must not contain the personalized member name in discreet mode');

    // 1.3 spoken SSML remains the personalized question.
    assert.match(result.response.outputSpeech.ssml, /Elena, we planned to check/i);
    assert.equal(COPY.dueFollowup('Elena'), PERSONALIZED_QUESTION);
});

// Property 2: Preservation - Non-Discreet Presentation Unchanged (Requirement 1.4)
test('non-discreet mode keeps the personalized due follow-up question on screen and card', async () => {
    await createDueFollowup();
    const result = await handler(launchRequest(), {});

    const directive = result.response.directives.find(item => item.type === 'Alexa.Presentation.APL.RenderDocument');
    assert.ok(directive);
    assert.equal(directive.datasources.followupData.question, PERSONALIZED_QUESTION);

    const card = result.response.card;
    const cardBody = card.content || card.text;
    assert.equal(cardBody, PERSONALIZED_QUESTION);

    // Spoken prompt and reprompt remain personalized in non-discreet mode.
    assert.match(result.response.outputSpeech.ssml, /Elena, we planned to check/i);
    assert.match(result.response.reprompt.outputSpeech.ssml, /Elena, we planned to check/i);
});
// ---------------------------------------------------------------------------
// Bug 2 — Bind due-follow-up completion strictly to attributes.followupId
// ---------------------------------------------------------------------------

async function createPendingFollowup(signal, dueDate, dueTime) {
    return care.createFollowup({
        ownerId: OWNER_ID,
        memberName: 'Elena',
        signal,
        dueDate,
        dueTime
    });
}

// Property 1: Bug Condition - Stale Button Completes Wrong Follow-up (Requirements 2.1, 2.2)
test('a stale due-follow-up button never completes a different follow-up', async () => {
    // Target the button was rendered for.
    const target = await createDueFollowup();
    const launch = await handler(launchRequest(), {});
    // The session now points strictly at the rendered target.
    assert.equal(launch.sessionAttributes.followupId, target.followupId);

    // The targeted follow-up becomes non-pending out of band (stale session),
    // and a different pending follow-up exists for the same member.
    await care.cancelFollowup({ ownerId: OWNER_ID, memberName: 'Elena', followupId: target.followupId });
    const other = await createPendingFollowup('appetite', '2030-01-11', '09:00');

    // Fire the stale button (valid status) using the stale session attributes.
    const result = await handler(userEvent(launch.sessionAttributes, 'better'), {});

    // 2.2 A missing/non-pending target is rejected with a safe prompt and completes nothing.
    assert.doesNotMatch(result.response.outputSpeech.ssml, /No caregiver alert was needed/i,
        'a stale button must not report a successful completion');

    // 2.1 The other (non-targeted) follow-up must remain untouched — it must NOT be completed.
    const otherStored = await care.getFollowupById({ ownerId: OWNER_ID, memberName: 'Elena', followupId: other.followupId });
    assert.equal(otherStored.status, 'pending', 'a stale button must never complete a different follow-up');

    // The original target stays cancelled (nothing resurrected/completed).
    const targetStored = await care.getFollowupById({ ownerId: OWNER_ID, memberName: 'Elena', followupId: target.followupId });
    assert.equal(targetStored.status, 'cancelled');
});

// Property 2: Preservation - Valid Completion + Idempotent Replay (Requirements 2.1, 2.3)
test('a valid pending due button completes exactly that follow-up, and replay is idempotent', async () => {
    const target = await createDueFollowup();
    const launch = await handler(launchRequest(), {});
    assert.equal(launch.sessionAttributes.followupId, target.followupId);

    const completed = await handler(userEvent(launch.sessionAttributes, 'better'), {});
    assert.match(completed.response.outputSpeech.ssml, /feel better/i);
    assert.match(completed.response.outputSpeech.ssml, /No caregiver alert was needed/i);

    // 2.1 Exactly the targeted follow-up is completed.
    const stored = await care.getFollowupById({ ownerId: OWNER_ID, memberName: 'Elena', followupId: target.followupId });
    assert.equal(stored.status, 'completed');
    assert.equal(stored.result, 'better');

    // 2.3 Idempotent replay of the same request returns the same success copy, unchanged.
    const replay = await handler(userEvent(launch.sessionAttributes, 'better'), {});
    assert.equal(replay.response.outputSpeech.ssml, completed.response.outputSpeech.ssml);
    const afterReplay = await care.getFollowupById({ ownerId: OWNER_ID, memberName: 'Elena', followupId: target.followupId });
    assert.equal(afterReplay.status, 'completed');
    assert.equal(afterReplay.result, 'better');
});

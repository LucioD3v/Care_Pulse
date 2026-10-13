'use strict';

const assert = require('node:assert/strict');
const { beforeEach, afterEach, test, mock } = require('node:test');
const { SNSClient } = require('@aws-sdk/client-sns');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const care = require('../care_service');
const repo = require('../care_repository');
const access = require('../access_control');
const runtime = require('../runtime_config');
const bee = require('../bee_link');
const { ingestBeeContext } = require('../tools/ingestBeeContext');
const { handler: alexa } = require('../index');
const { handler: mcp } = require('../mcp_http');
const { callMcpTool } = require('../mcp_contracts');
const base = { ownerId: 'a', memberName: 'Elena' };
const report = { ...base, signal: 'tiredness', state: 'reported' };
let environment;

beforeEach(() => {
    environment = { ...process.env };
    process.env.CARE_MODE = 'demo';
    process.env.CARE_STORAGE_MODE = 'memory';
    for (const name of ['CARE_TABLE_NAME', 'SNS_TOPIC_ARN', 'DEMO_OWNER_ID', 'AWS_LAMBDA_FUNCTION_NAME', 'STAGE']) delete process.env[name];
    repo.resetMockRecords();
    mock.method(console, 'info', () => {});
});
afterEach(() => {
    mock.restoreAll();
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
});

async function followup(signal = 'tiredness') {
    return care.createFollowup({ ...base, signal, dueDate: '2030-01-10', dueTime: '18:00' });
}
async function consentFor(item, caregiverName = 'Laura') {
    return care.requestConsent({ ...base, caregiverName, signal: item.signal, followupId: item.followupId });
}
async function readyAlert(caregiverName = 'Laura') {
    const item = await followup();
    const consent = await consentFor(item, caregiverName);
    await care.completeFollowup({ followup: item, status: 'same' });
    return { item, consent, input: { ...base, caregiverName, signal: item.signal, followupStatus: 'same', consentId: consent.consentId } };
}
function event(name, slots = {}, attributes = {}, requestId = 'r') {
    return {
        version: '1.0', session: { user: { userId: 'test' }, application: { applicationId: 'test' }, attributes },
        context: { System: { user: { userId: 'test' }, application: { applicationId: 'test' }, device: { supportedInterfaces: {} } } },
        request: { type: 'IntentRequest', intent: { name, slots }, requestId, timestamp: new Date().toISOString(), locale: 'en-US' }
    };
}

test('memory storage requires explicit local demo mode and is forbidden in Lambda', async () => {
    delete process.env.CARE_MODE;
    await assert.rejects(repo.getRecord('x', 'y'), /CARE_TABLE_NAME/);
    process.env.CARE_MODE = 'demo';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'deployed';
    await assert.rejects(repo.getRecord('x', 'y'), /CARE_TABLE_NAME/);
    process.env.CARE_TABLE_NAME = 'table';
    process.env.STAGE = 'production';
    assert.throws(runtime.useMemory, /forbidden/);
});

test('missing Alexa identity and unsigned MCP requests cannot reach storage', async () => {
    const request = event('ReportWellnessIntent');
    delete request.session.user;
    delete request.context.System.user;
    assert.match((await alexa(request, {})).response.outputSpeech.text, /not authorized/);
    process.env.CARE_MODE = 'production';
    process.env.MCP_API_KEY = 'shared-key';
    const result = await mcp({ headers: { 'x-carepulse-mcp-key': 'shared-key' }, body: '{}' }, {});
    assert.equal(result.statusCode, 401);
});

test('production member reads, writes, and supplied contexts enforce roles and storage consent', async () => {
    process.env.CARE_MODE = 'production';
    const principal = { ownerId: 'a', profile: { members: [{ memberId: 'm', name: 'Elena', status: 'active', storageConsentGranted: true, role: 'viewer' }] } };
    await access.withPrincipal(principal, async () => {
        assert.ok(access.authorizeMember('a', 'Elena'));
        assert.throws(() => access.authorizeMember('b', 'Elena'), access.AccessError);
        assert.throws(() => access.authorizeMember('a', 'Someone else'), access.AccessError);
        await assert.rejects(care.logWellnessEvent(report), access.AccessError);
        await assert.rejects(care.getWellnessHistory({ ...base, ownerId: 'b', context: { timezone: 'UTC' } }), access.AccessError);
        principal.profile.members[0].storageConsentGranted = false;
        assert.throws(() => access.authorizeMember('a', 'Elena'), access.AccessError);
    });
});

test('a demo principal cannot override its household', async () => {
    await access.withPrincipal({ ownerId: 'a', demo: true }, async () => {
        await assert.rejects(care.getCareContext({ ownerId: 'b', memberName: 'Elena' }), access.AccessError);
    });
});

test('concurrent request replays save one event and reject different arguments', async () => {
    await access.withPrincipal({ ownerId: 'a', requestId: 'same-request', demo: true }, async () => {
        const [first, second] = await Promise.all([care.logWellnessEvent(report), care.logWellnessEvent(report)]);
        assert.equal(first.sk, second.sk);
        assert.equal((await care.getWellnessHistory(base)).length, 1);
        await assert.rejects(care.logWellnessEvent({ ...report, state: 'worse' }), /reused/);
    });
});

test('follow-up creation is idempotent and exact selection keeps signal and time', async () => {
    await access.withPrincipal({ ownerId: 'a', requestId: 'same-request', demo: true }, async () => {
        const [first, second] = await Promise.all([followup(), followup()]);
        assert.equal(first.followupId, second.followupId);
    });
    const sleep = await followup('sleep');
    assert.equal((await care.getPendingFollowup({ ...base, signal: 'sleep', dueTime: '18:00' })).followupId, sleep.followupId);
    assert.equal(await care.getPendingFollowup({ ...base, signal: 'sleep', dueTime: '20:00' }), null);
});

test('consent rejects fabricated follow-ups, different signals and expired permission', async () => {
    await assert.rejects(consentFor({ signal: 'sleep', followupId: 'fabricated' }), /pending/);
    const item = await followup();
    await assert.rejects(consentFor({ ...item, signal: 'sleep' }), /signal/);
    await assert.rejects(care.requestConsent({ ...base, caregiverName: 'Laura', signal: item.signal,
        followupId: item.followupId, expiresAt: 1 }), /expire/);
});

test('alternate caregiver replaces the previous binding and dashboard uses the chosen caregiver', async () => {
    const item = await followup();
    const old = await consentFor(item);
    const chosen = await consentFor(item, 'Maya');
    assert.equal((await repo.getRecord(old.pk, old.sk)).status, 'revoked');
    assert.equal(await care.findActiveConsent({ ...base, caregiverName: 'Laura', signal: item.signal, followupId: item.followupId }), null);
    assert.equal((await care.getCareDashboard(base)).permission, 'Active for Maya on this follow-up');
    assert.equal((await care.getFollowupById({ ...base, followupId: item.followupId })).consentId, chosen.consentId);
});

test('completion commits one result and durable alert under concurrency', async () => {
    const item = await followup();
    await consentFor(item);
    await Promise.all([care.completeFollowup({ followup: item, status: 'same' }), care.completeFollowup({ followup: item, status: 'same' })]);
    assert.equal((await care.getWellnessHistory(base)).length, 1);
    assert.equal((await repo.getRecord(item.pk, 'ALERT#' + item.followupId)).status, 'pending');
    await assert.rejects(care.completeFollowup({ followup: item, status: 'worse' }), /no longer pending/);
});

test('replaying an ASK completion cannot accidentally complete the next pending check-in', async () => {
    process.env.DEMO_OWNER_ID = 'a';
    await followup('sleep');
    await followup('tiredness');
    const request = event('CompleteFollowupIntent', { followupStatus: { name: 'followupStatus', value: 'better' } }, {}, 'same-completion');
    const prompt = await alexa(request, {});
    assert.match(prompt.response.outputSpeech.ssml, /Which check-in/i);
    assert.equal((await care.listFollowups(base)).followups.length, 2);
    const selection = event('SelectFollowupIntent', { choice: { name: 'choice', value: '1' } },
        prompt.sessionAttributes, 'selected-completion');
    await alexa(selection, {});
    await alexa(selection, {});
    assert.equal((await care.listFollowups(base)).followups.length, 1);
    assert.equal((await care.getWellnessHistory(base)).length, 1);
});

test('a forged authorization flag cannot publish without persisted consent and completion', async () => {
    let sends = 0;
    mock.method(SNSClient.prototype, 'send', async () => { sends++; return {}; });
    await assert.rejects(care.sendCaregiverAlert({ ...base, caregiverName: 'Laura', signal: 'tiredness',
        followupStatus: 'same', consentId: 'forged', authorized: true }), access.AccessError);
    const item = await followup();
    const consent = await consentFor(item);
    await assert.rejects(care.sendCaregiverAlert({ ...base, caregiverName: 'Laura', signal: 'tiredness',
        followupStatus: 'same', consentId: consent.consentId, authorized: true }), access.AccessError);
    assert.equal(sends, 0);
});

test('SNS acceptance is persisted and a repeated alert does not publish twice', async () => {
    process.env.SNS_TOPIC_ARN = 'arn:test:demo-topic';
    let sends = 0;
    mock.method(SNSClient.prototype, 'send', async () => { sends++; return { MessageId: 'accepted-id' }; });
    const { input } = await readyAlert('Maya');
    const results = await Promise.all([care.sendCaregiverAlert(input), care.sendCaregiverAlert(input)]);
    assert.equal(sends, 1);
    assert.ok(results.some(result => result.sent));
    assert.equal((await care.sendCaregiverAlert(input)).messageId, 'accepted-id');
    assert.equal(sends, 1);
});

test('unknown publication outcomes remain durable and are never automatically resent', async () => {
    process.env.SNS_TOPIC_ARN = 'arn:test:demo-topic';
    let sends = 0;
    mock.method(SNSClient.prototype, 'send', async () => { sends++; throw new Error('connection lost'); });
    const { input, item } = await readyAlert();
    assert.equal((await care.sendCaregiverAlert(input)).status, 'unknown');
    assert.equal((await care.sendCaregiverAlert(input)).status, 'unknown');
    assert.equal(sends, 1);
    assert.equal((await repo.getRecord(item.pk, 'ALERT#' + item.followupId)).status, 'unknown');
});

test('known failures allow bounded explicit retries and revoked consent cancels the outbox', async () => {
    process.env.SNS_TOPIC_ARN = 'arn:test:demo-topic';
    let sends = 0;
    mock.method(SNSClient.prototype, 'send', async () => { sends++; throw Object.assign(new Error('rejected'), { $metadata: { httpStatusCode: 403 } }); });
    const { input, item } = await readyAlert();
    for (let i = 0; i < 5; i++) await care.sendCaregiverAlert(input);
    assert.equal(sends, 3);
    await care.revokeConsent({ ...base, followupId: item.followupId });
    assert.equal((await repo.getRecord(item.pk, 'ALERT#' + item.followupId)).status, 'cancelled');
    await assert.rejects(care.sendCaregiverAlert(input), access.AccessError);
});

test('server errors keep an unknown publication outcome and prevent automatic duplicate sends', async () => {
    process.env.SNS_TOPIC_ARN = 'arn:test:demo-topic';
    let sends = 0;
    mock.method(SNSClient.prototype, 'send', async () => { sends++; throw Object.assign(new Error('server error'), { $metadata: { httpStatusCode: 500 } }); });
    const { input } = await readyAlert();
    assert.equal((await care.sendCaregiverAlert(input)).status, 'unknown');
    assert.equal((await care.sendCaregiverAlert(input)).status, 'unknown');
    assert.equal(sends, 1);
});

test('an unconfigured demo alert can be explicitly retried after configuring SNS', async () => {
    const { input } = await readyAlert();
    assert.equal((await care.sendCaregiverAlert(input)).status, 'unconfigured');
    process.env.SNS_TOPIC_ARN = 'arn:test:demo-topic';
    mock.method(SNSClient.prototype, 'send', async () => ({ MessageId: 'configured-now' }));
    assert.equal((await care.sendCaregiverAlert(input)).status, 'accepted');
});

test('declining permission never promises to recall a publication already in progress', async () => {
    process.env.DEMO_OWNER_ID = 'a';
    const { item } = await readyAlert();
    await repo.updateRecord(item.pk, 'ALERT#' + item.followupId, { status: 'sending' });
    const response = await alexa(event('AMAZON.NoIntent', {}, { memberName: 'Elena', followupId: item.followupId,
        conversationState: 'AWAITING_CONSENT_CONFIRMATION' }), {});
    assert.match(response.response.outputSpeech.ssml, /cannot be recalled/);
});

test('revocation reports an alert already claimed for sending without promising recall', async () => {
    const { item } = await readyAlert();
    await repo.updateRecord(item.pk, 'ALERT#' + item.followupId, { status: 'sending' });
    assert.equal((await care.revokeConsent({ ...base, followupId: item.followupId })).mayHaveBeenSent, true);
});

test('No withdraws an existing permission and a later bare Yes does not restore it', async () => {
    process.env.DEMO_OWNER_ID = 'a';
    const item = await followup();
    const consent = await consentFor(item);
    const response = await alexa(event('AMAZON.NoIntent', {}, { memberName: 'Elena', caregiverName: 'Laura',
        signal: item.signal, followupId: item.followupId, conversationState: 'AWAITING_CONSENT_CONFIRMATION' }), {});
    assert.equal((await repo.getRecord(consent.pk, consent.sk)).status, 'revoked');
    await alexa(event('AMAZON.YesIntent', {}, response.sessionAttributes), {});
    assert.equal((await repo.getRecord(consent.pk, consent.sk)).status, 'revoked');
});

test('sharing explanation and revocation are available through ASK', async () => {
    process.env.DEMO_OWNER_ID = 'a';
    const { item, consent } = await readyAlert();
    const explained = await alexa(event('ExplainSharingIntent'), {});
    assert.match(explained.response.outputSpeech.ssml, /36 hours/);
    await alexa(event('RevokeSharingIntent'), {});
    assert.equal((await repo.getRecord(consent.pk, consent.sk)).status, 'revoked');
    assert.equal((await repo.getRecord(item.pk, 'ALERT#' + item.followupId)).status, 'cancelled');
});

test('MCP can list, complete and cancel exact follow-ups without private storage fields', async () => {
    const item = await followup();
    const list = await callMcpTool('list_followups', base);
    assert.equal(list.followups.length, 1);
    assert.equal(list.followups[0].pk, undefined);
    const completed = await callMcpTool('complete_followup', { ...base, followupId: item.followupId, status: 'better' });
    assert.equal(completed.status, 'completed');
    const next = await followup('sleep');
    await consentFor(next);
    assert.equal((await callMcpTool('cancel_followup', { ...base, followupId: next.followupId })).status, 'cancelled');
    assert.equal((await callMcpTool('list_followups', base)).followups.length, 0);
});

test('invalid signals, states, sleep hours and follow-up status are never stored', async () => {
    for (const change of [{ signal: 'unsupported' }, { state: 'invented' }, { signal: 'sleep', numericValue: -1 },
        { signal: 'sleep', numericValue: 25 }, { signal: 'sleep', numericValue: NaN }]) {
        await assert.rejects(care.logWellnessEvent({ ...report, ...change }), TypeError);
    }
    const item = await followup();
    await assert.rejects(care.completeFollowup({ followup: item, status: 'maybe' }), TypeError);
    assert.equal((await care.getWellnessHistory(base)).length, 0);
});

test('ASK elicits unknown status and invalid sleep hours, and does not invent intensity', async () => {
    process.env.DEMO_OWNER_ID = 'a';
    const invalid = await alexa(event('CompleteFollowupIntent', { followupStatus: { name: 'followupStatus', value: 'maybe' } }), {});
    assert.equal(invalid.response.directives[0].slotToElicit, 'followupStatus');
    const badSleep = await alexa(event('ReportWellnessIntent', { sleepHours: { name: 'sleepHours', value: '40' } }), {});
    assert.equal(badSleep.response.directives[0].slotToElicit, 'sleepHours');
    await alexa(event('ReportWellnessIntent', { wellnessSignal: { name: 'wellnessSignal', value: 'tiredness' } }), {});
    assert.equal((await care.getWellnessHistory(base))[0].state, 'reported');
});

test('Bee exports at the same timestamp keep distinct source IDs and remain replayable', async () => {
    const { linkCode } = await bee.grantBeeConsent(base);
    const exportedAt = new Date().toISOString();
    const first = { exportedAt, sourceId: 'fact:1', facts: [{ text: 'I feel tired', confirmed: true }] };
    const second = { ...first, sourceId: 'fact:2' };
    assert.equal((await ingestBeeContext({ linkCode, beeExport: first })).eventsIngested, 1);
    assert.equal((await ingestBeeContext({ linkCode, beeExport: second })).eventsIngested, 1);
    assert.equal((await ingestBeeContext({ linkCode, beeExport: first })).skipped, 1);
});

test('a stale Bee authorization cannot write after revocation or relinking', async () => {
    const { linkCode } = await bee.grantBeeConsent(base);
    const resolved = await bee.resolveBeeLink(linkCode);
    await bee.revokeBeeConsent(base);
    await bee.grantBeeConsent(base);
    const record = { pk: 'USER#a', sk: 'EVENT#elena#stale', provenance: 'bee' };
    await assert.rejects(repo.putRecordIfAbsent(record, { checks: [resolved.consentCheck] }), /Concurrent/);
    assert.equal(await repo.getRecord(record.pk, record.sk), null);
});

test('Bee relinking is blocked until an interrupted revocation is resumed', async () => {
    await bee.grantBeeConsent(base);
    await repo.updateRecord('USER#a', 'BEECONSENT#elena', { status: 'revoking' });
    await assert.rejects(bee.grantBeeConsent(base), /deletion must finish/);
    await bee.revokeBeeConsent(base);
    assert.ok((await bee.grantBeeConsent(base)).linkCode);
});

test('expired wellness records are omitted before asynchronous DynamoDB TTL deletion', async () => {
    const saved = await care.logWellnessEvent(report);
    await repo.updateRecord(saved.pk, saved.sk, { expiresAt: 1 });
    assert.equal((await care.getWellnessHistory(base)).length, 0);
    assert.equal((await care.getWellnessHistoryPage(base)).events.length, 0);
});

test('DynamoDB Bee writes combine consent and event conditions in one transaction', async () => {
    process.env.CARE_TABLE_NAME = 'test';
    const commands = [];
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => { commands.push(command); return {}; });
    await repo.putRecordIfAbsent({ pk: 'USER#a', sk: 'EVENT#x' }, { checks: [{ pk: 'USER#a', sk: 'BEECONSENT#elena',
        equals: { status: 'active', consentId: 'c' }, after: { expiresAt: 1 } }] });
    assert.equal(commands[0].constructor.name, 'TransactWriteCommand');
    assert.equal(commands[0].input.TransactItems.length, 2);
    assert.match(commands[0].input.TransactItems[0].ConditionCheck.ConditionExpression, />/);
    assert.match(commands[0].input.TransactItems[1].Put.ConditionExpression, /attribute_not_exists/);
});

test('JWT verification checks signature, issuer, audience, expiry, scope and access-token type', async () => {
    const jose = await import('jose');
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const jwk = { ...await jose.exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    process.env.MCP_JWT_ISSUER = 'https://issuer.example';
    process.env.MCP_JWT_AUDIENCE = 'https://mcp.example';
    process.env.MCP_JWKS_URI = 'https://issuer.example/jwks';
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200, headers: { 'content-type': 'application/json' }
    }));
    const sign = (changes = {}, key = privateKey) => new jose.SignJWT({
        sub: 'user', iss: 'https://issuer.example', aud: 'https://mcp.example',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
        token_use: 'access', scope: 'carepulse/access', ...changes
    }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(key);
    const { verifyToken } = require('../identity_tokens');
    assert.equal((await verifyToken(await sign())).sub, 'user');
    for (const change of [{ iss: 'https://wrong.example' }, { aud: 'another-api' }, { exp: 1 },
        { scope: 'unrelated' }, { token_use: 'id' }]) await assert.rejects(verifyToken(await sign(change)));
    const other = await jose.generateKeyPair('RS256');
    await assert.rejects(verifyToken(await sign({}, other.privateKey)));
    await assert.rejects(verifyToken('unsigned-token'));
});

test('MCP production identity resolves an approved server-side binding instead of caller claims', async () => {
    process.env.CARE_MODE = 'production';
    process.env.CARE_TABLE_NAME = 'test';
    mock.method(require('../identity_tokens'), 'verifyToken', async () => ({ iss: 'https://issuer.example', sub: 'user' }));
    let active = true;
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => ({ Item:
        command.input.Key.sk === 'BINDING' ? { status: active ? 'active' : 'revoked', ownerId: 'a' }
            : { status: 'active', members: [{ memberId: 'm', name: 'Elena', status: 'active', storageConsentGranted: true, role: 'owner' }] }
    }));
    const principal = await access.fromMcp({ headers: { Authorization: 'Bearer verified-by-test' } });
    assert.equal(principal.ownerId, 'a');
    active = false;
    await assert.rejects(access.fromMcp({ headers: { Authorization: 'Bearer verified-by-test' } }), access.AccessError);
});

test('production notification checks the sole verified subscription before publishing', async () => {
    process.env.CARE_MODE = 'production';
    const destination = { topicArn: 'arn:test:private-topic', subscriptionArn: 'arn:test:subscription', endpoint: 'test@example.invalid' };
    process.env.SNS_ALLOWED_TOPIC_ARNS = destination.topicArn;
    let multiple = true, sends = 0;
    mock.method(SNSClient.prototype, 'send', async command => {
        if (command.constructor.name === 'ListSubscriptionsByTopicCommand') {
            const subscription = { SubscriptionArn: destination.subscriptionArn, Endpoint: destination.endpoint, Protocol: 'email' };
            return { Subscriptions: multiple ? [subscription, subscription] : [subscription] };
        }
        sends++;
        return { MessageId: 'id' };
    });
    const publish = require('../sns_notifier').sendCaregiverAlert;
    assert.equal((await publish({ memberName: 'Elena', destination })).status, 'failed');
    assert.equal(sends, 0);
    multiple = false;
    assert.equal((await publish({ memberName: 'Elena', destination })).status, 'accepted');
    assert.equal(sends, 1);
});

test('ASK manual elicitation slots exist in the dialog model', () => {
    const model = require('../../skill-package/interactionModels/custom/en-US.json').interactionModel;
    assert.equal(model.dialog.delegationStrategy, 'SKILL_RESPONSE');
    const slots = new Map(model.dialog.intents.map(intent => [intent.name, intent.slots.map(slot => slot.name)]));
    for (const [intent, slot] of [['ReportWellnessIntent', 'wellnessSignal'], ['ReportWellnessIntent', 'sleepHours'],
        ['ReportWellnessIntent', 'intensity'], ['CompleteFollowupIntent', 'followupStatus']]) {
        assert.ok(slots.get(intent).includes(slot));
    }
    const complete = model.languageModel.intents.find(intent => intent.name === 'CompleteFollowupIntent');
    assert.ok(complete.samples.includes('I still feel {followupStatus}'));
});

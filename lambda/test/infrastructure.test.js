'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const YAML = require('yaml');
const source = fs.readFileSync(path.join(__dirname, '../../serverless.yml'), 'utf8');

test('Serverless uses separate execution roles and scoped model resources', () => {
    const config = YAML.parse(source);
    const resources = config.resources.Resources;
    assert.equal(config.functions.alexaSkill.role['Fn::GetAtt'][0], 'AlexaRole');
    assert.equal(config.functions.mcpGateway.role['Fn::GetAtt'][0], 'McpRole');
    assert.equal(config.functions.followupMonitor.role['Fn::GetAtt'][0], 'MonitorRole');
    assert.doesNotMatch(JSON.stringify(resources.McpRole), /bedrock:/);
    assert.doesNotMatch(JSON.stringify(resources.MonitorRole), /sns:Publish|PutItem|DeleteItem/);
    assert.match(JSON.stringify(resources.AlexaRole), /BedrockInvokeResources/);
    assert.ok(config.functions.alexaSkill.environment.ALEXA_SKILL_ID);
    assert.equal(resources.CaregiverAlertsTopic.Properties.KmsMasterKeyId.Ref, 'NotificationKey');
    assert.equal(resources.CarePulseTable.Properties.GlobalSecondaryIndexes[0].IndexName, 'PendingFollowups');
    assert.equal(resources.AlexaLatencyAlarm.Properties.ExtendedStatistic, 'p95');
    assert.ok(resources.McpNotificationAlarm);
    assert.ok(resources.OverdueFollowupsAlarm);
    assert.ok(config.functions.mcpGateway.events.some(event => event.httpApi?.method === 'GET'));
});

test('all Lambda packages exclude tests and migration utilities', () => {
    const config = YAML.parse(source);
    for (const fn of Object.values(config.functions)) {
        assert.ok(fn.package.patterns.includes('!lambda/test/**'));
        assert.ok(fn.package.patterns.includes('!lambda/backfill_followup_index.js'));
        assert.ok(fn.package.patterns.includes('!**/.env*'));
    }
});

test('ASK CloudFormation YAML retains scoped logs, model access and encrypted notifications', () => {
    const template = fs.readFileSync(path.join(__dirname, '../../infrastructure/cfn-deployer/skill-stack.yaml'), 'utf8');
    const scalar = ['Ref', 'GetAtt', 'Sub'].map(name => ({
        tag: '!' + name, resolve: value => ({ [name]: value })
    }));
    const sequence = ['If', 'Equals', 'Not'].map(name => ({
        tag: '!' + name, collection: 'seq', resolve: value => value
    }));
    const document = YAML.parseDocument(template, { customTags: [...scalar, ...sequence] });
    assert.deepEqual(document.errors, []);
    const config = document.toJS();
    assert.ok(config.Resources.AlexaSkillFunction.Properties.Environment.Variables.ALEXA_SKILL_ID);
    assert.ok(config.Resources.AlexaSkillLogPolicy);
    assert.ok(config.Resources.NotificationKey);
    assert.equal(config.Resources.AlexaSkillFunction.Properties.Environment.Variables.CARE_TABLE_NAME.Ref, 'CarePulseTable');
    assert.equal(config.Resources.CarePulseTable.DeletionPolicy, 'Retain');
    assert.deepEqual(config.Resources.CarePulseTable.Properties.KeySchema.map(key => key.AttributeName), ['pk', 'sk']);
    assert.equal(config.Resources.CarePulseTable.Properties.GlobalSecondaryIndexes[0].IndexName, 'PendingFollowups');
    assert.ok(config.Resources.HealthMetricsTable, 'The legacy table must remain in the stack.');
    assert.match(template, /BedrockResourceArns/);
    assert.doesNotMatch(template, /logs:\*/);
});

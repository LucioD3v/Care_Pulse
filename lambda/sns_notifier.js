'use strict';

const { SNSClient, PublishCommand, ListSubscriptionsByTopicCommand } = require('@aws-sdk/client-sns');
const { metric, sendWithBudget } = require('./observability');
const { isDemo } = require('./runtime_config');

const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 1 });

function formatAlert({ memberName, caregiverName, signal, followupStatus, consentId }) {
    return {
        subject: 'CarePulse check-in',
        message: 'CarePulse: A person who authorized this check-in would appreciate a call. Please contact them directly. No wellness details are included in this notification.',
        payload: {
            source: 'CarePulse MCP',
            memberName,
            caregiverName: caregiverName || null,
            signal: signal || null,
            followupStatus: followupStatus || null,
            consentId,
            createdAt: new Date().toISOString(),
            urgency: 'normal'
        }
    };
}

async function sendCaregiverAlert(alert) {
    const formatted = formatAlert(alert);
    const topicArn = isDemo() ? process.env.SNS_TOPIC_ARN : alert.destination?.topicArn;
    if (!topicArn) {
        metric('NotificationUnconfigured');
        return { sent: false, simulated: isDemo(), status: 'unconfigured' };
    }

    try {
        if (!isDemo()) {
            const destination = alert.destination;
            const allowed = (process.env.SNS_ALLOWED_TOPIC_ARNS || '').split(',');
            if (!allowed.includes(topicArn)) return { sent: false, simulated: false, status: 'unconfigured' };
            const subscriptions = await sendWithBudget(snsClient, new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
            const only = subscriptions.Subscriptions?.[0];
            if (subscriptions.NextToken || subscriptions.Subscriptions?.length !== 1
                || only.SubscriptionArn !== destination.subscriptionArn || only.Endpoint !== destination.endpoint
                || !['email', 'sms'].includes(only.Protocol) || !only.SubscriptionArn.startsWith('arn:')) {
                return { sent: false, simulated: false, status: 'failed' };
            }
        }
        const result = await sendWithBudget(snsClient, new PublishCommand({
            TopicArn: topicArn,
            Subject: formatted.subject.slice(0, 100),
            Message: formatted.message,
            MessageAttributes: {
                urgency: { DataType: 'String', StringValue: 'normal' },
                source: { DataType: 'String', StringValue: 'CarePulse MCP' }
            }
        }));
        metric('NotificationsAccepted');
        return { sent: true, simulated: false, status: 'accepted', messageId: result.MessageId };
    } catch (error) {
        const code = error.$metadata?.httpStatusCode;
        const status = code >= 400 && code < 500 && code !== 408 ? 'failed' : 'unknown';
        metric('NotificationFailures');
        if (status === 'unknown') metric('NotificationUnknown');
        return { sent: false, simulated: false, status };
    }
}

module.exports = { sendCaregiverAlert, formatAlert };

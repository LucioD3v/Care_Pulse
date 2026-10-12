'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { metric, sendWithBudget } = require('./observability');

const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 1 });

function formatAlert({ memberName, caregiverName, signal, followupStatus, consentId }) {
    const readableSignal = String(signal || 'wellness concern').replace(/-/g, ' ');
    return {
        subject: `CarePulse check-in for ${memberName}`,
        message: `CarePulse: ${memberName} reported ${readableSignal} again during today's follow-up. Please check in with them. No other wellness data was shared.`,
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
    const topicArn = process.env.SNS_TOPIC_ARN;
    if (!topicArn) {
        metric('NotificationUnconfigured');
        return { sent: false, simulated: true, status: 'unconfigured' };
    }

    try {
        const result = await sendWithBudget(snsClient, new PublishCommand({
            TopicArn: topicArn,
            Subject: formatted.subject.slice(0, 100),
            Message: formatted.message,
            MessageAttributes: {
                memberName: { DataType: 'String', StringValue: String(alert.memberName) },
                urgency: { DataType: 'String', StringValue: 'normal' },
                source: { DataType: 'String', StringValue: 'CarePulse MCP' }
            }
        }));
        metric('NotificationsAccepted');
        return { sent: true, simulated: false, status: 'accepted', messageId: result.MessageId };
    } catch (error) {
        const status = error.$metadata?.httpStatusCode >= 400 ? 'failed' : 'unknown';
        metric('NotificationFailures');
        if (status === 'unknown') metric('NotificationUnknown');
        return { sent: false, simulated: false, status };
    }
}

module.exports = { sendCaregiverAlert, formatAlert };

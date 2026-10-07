'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

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
        console.info('SNS mock alert created; configure SNS_TOPIC_ARN to enable delivery.');
        return { sent: false, simulated: true, message: formatted.message };
    }

    try {
        const result = await snsClient.send(new PublishCommand({
            TopicArn: topicArn,
            Subject: formatted.subject.slice(0, 100),
            Message: formatted.message,
            MessageAttributes: {
                memberName: { DataType: 'String', StringValue: String(alert.memberName) },
                urgency: { DataType: 'String', StringValue: 'normal' },
                source: { DataType: 'String', StringValue: 'CarePulse MCP' }
            }
        }));
        return { sent: true, simulated: false, messageId: result.MessageId, message: formatted.message };
    } catch (error) {
        console.warn('SNS publish failed; retaining a local mock result:', error.message);
        return { sent: false, simulated: true, message: formatted.message, error: error.name };
    }
}

module.exports = { sendCaregiverAlert, formatAlert };

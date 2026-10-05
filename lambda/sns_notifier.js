'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({ region: process.env.AWS_REGION || 'us-east-1' });

function formatAlert({ memberName, metric, value, unit, message }) {
    const reading = metric && value !== undefined
        ? `${metric} is ${value}${unit ? ` ${unit}` : ''}`
        : message || 'a caregiver check-in was requested';
    return {
        subject: `CarePulse alert for ${memberName}`,
        message: `Caregiver Alert: ${memberName}'s ${reading}. ${message || 'Please check in as soon as possible.'}`,
        payload: {
            source: 'CarePulse MCP',
            memberName,
            metric: metric || null,
            value: value ?? null,
            unit: unit || null,
            message: message || null,
            createdAt: new Date().toISOString(),
            urgency: 'high'
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
                urgency: { DataType: 'String', StringValue: 'high' },
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
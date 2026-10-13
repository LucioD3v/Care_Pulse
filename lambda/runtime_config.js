'use strict';

function isDemo() {
    const demo = process.env.CARE_MODE === 'demo';
    if (demo && ['prod', 'production'].includes(process.env.STAGE)) {
        throw new Error('Demo mode is forbidden in production.');
    }
    return demo;
}

function useMemory() {
    const demo = isDemo();
    if (process.env.CARE_TABLE_NAME) return false;
    if (process.env.CARE_STORAGE_MODE !== 'memory' || !demo || process.env.AWS_LAMBDA_FUNCTION_NAME) {
        throw new Error('CARE_TABLE_NAME is required. In-memory storage is only available in explicit local demo mode.');
    }
    return true;
}

function retentionSeconds() {
    const days = Number(process.env.WELLNESS_RETENTION_DAYS || 90);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Invalid retention configuration.');
    return days * 86400;
}

module.exports = { isDemo, useMemory, retentionSeconds };

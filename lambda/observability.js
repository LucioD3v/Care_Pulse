'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const requests = new AsyncLocalStorage();
let coldStart = true;

function metric(name, value = 1, unit = 'Count') {
    const context = requests.getStore() || {};
    console.info(JSON.stringify({
        _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [{
                Namespace: 'CarePulse',
                Dimensions: [['Service', 'Stage']],
                Metrics: [{ Name: name, Unit: unit }]
            }]
        },
        Service: context.service || 'domain',
        Stage: process.env.STAGE || 'dev',
        correlationId: context.correlationId || 'background',
        [name]: value
    }));
}

function remainingMs(reserve = 0) {
    const deadline = requests.getStore()?.deadline;
    return deadline ? Math.max(0, deadline - Date.now() - reserve) : Infinity;
}

async function withRequest(service, context, budgetMs, action) {
    const started = Date.now();
    const isColdStart = coldStart;
    coldStart = false;
    const runtimeBudget = context?.getRemainingTimeInMillis
        ? Math.max(1, context.getRemainingTimeInMillis() - 500) : budgetMs;
    return requests.run({
        service,
        correlationId: context?.awsRequestId || randomUUID(),
        deadline: started + Math.min(budgetMs, runtimeBudget)
    }, async () => {
        metric('Requests');
        if (isColdStart) metric('ColdStarts');
        try {
            return await action();
        } catch (error) {
            metric('UnhandledErrors');
            throw error;
        } finally {
            metric('RequestDuration', Date.now() - started, 'Milliseconds');
        }
    });
}

async function sendWithBudget(client, command, timeoutMs = 2000, reserveMs = 500) {
    const duration = Math.min(timeoutMs, remainingMs(reserveMs));
    if (duration <= 0) throw new Error('Request time budget exhausted.');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            const error = new Error('Dependency time budget exhausted.');
            error.name = 'TimeoutError';
            reject(error);
        }, duration);
    });
    try {
        return await Promise.race([client.send(command, { abortSignal: controller.signal }), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { metric, withRequest, remainingMs, sendWithBudget };

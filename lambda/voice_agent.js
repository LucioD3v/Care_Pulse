'use strict';

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { metric, remainingMs, sendWithBudget } = require('./observability');
const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1', maxAttempts: 1 });

async function renderVoiceObservation({ memberName, signal, comparison }) {
    const templates = {
        standard: 'I recorded ' + memberName + "'s " + signal.replace(/-/g, ' ') + '. ' + comparison.summary,
        neutral: 'I saved your wellness report. ' + comparison.summary
    };
    const fallback = templates.standard;
    if (!process.env.BEDROCK_MODEL_ID || remainingMs(700) < 100) return fallback;
    const configured = Number(process.env.VOICE_TIMEOUT_MS || 1200);
    const timeout = Number.isFinite(configured) ? Math.max(50, Math.min(2000, configured)) : 1200;
    const started = Date.now();
    try {
        // The model selects approved wording; it cannot supply facts or sharing decisions.
        const response = await sendWithBudget(client, new ConverseCommand({
            modelId: process.env.BEDROCK_MODEL_ID,
            system: [{ text: 'Select one approved voice style: standard or neutral. Return only JSON with the template key, for example {"template":"standard"}. Do not generate speech.' }],
            messages: [{ role: 'user', content: [{ text: 'Choose a concise style for a saved wellness report.' }] }],
            inferenceConfig: { maxTokens: 30, temperature: 0 }
        }), timeout, 700);
        const text = response.output?.message?.content?.find(item => typeof item.text === 'string')?.text || '';
        if (text.length > 100) throw new Error('Invalid template selection.');
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1
            || !['standard', 'neutral'].includes(parsed.template)) throw new Error('Invalid template selection.');
        metric('VoiceGenerated');
        return templates[parsed.template];
    } catch {
        metric('VoiceFallbacks');
        return fallback;
    } finally {
        metric('VoiceDuration', Date.now() - started, 'Milliseconds');
    }
}

module.exports = { renderVoiceObservation };

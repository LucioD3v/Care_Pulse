'use strict';

const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

async function renderVoiceObservation({ memberName, signal, comparison }) {
    const fallback = comparison.changeObserved
        ? comparison.summary
        : `I recorded ${memberName}'s ${signal.replace(/-/g, ' ')}. ${comparison.summary}`;
    const bedrockRequired = process.env.REQUIRE_BEDROCK === 'true';
    if (!process.env.BEDROCK_MODEL_ID && bedrockRequired) {
        throw new Error('BEDROCK_MODEL_ID is required for the CarePulse runtime.');
    }
    if (!process.env.BEDROCK_MODEL_ID) {
        return fallback;
    }
    try {
        const response = await client.send(new ConverseCommand({
            modelId: process.env.BEDROCK_MODEL_ID,
            system: [{
                text: 'You are the CarePulse voice experience agent. Rewrite only the supplied facts as one short, warm, voice-first sentence. Never diagnose, infer a cause, classify urgency, authorize sharing, or decide whether to alert anyone. Return JSON only: {"speech":"..."}.'
            }],
            messages: [{
                role: 'user',
                content: [{ text: JSON.stringify({ memberName, signal, comparison, fallback }) }]
            }],
            inferenceConfig: { maxTokens: 100, temperature: 0.2 }
        }));
        const text = response.output?.message?.content?.find(item => item.text)?.text || '';
        const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
        return typeof parsed.speech === 'string' && parsed.speech.trim() ? parsed.speech.trim() : fallback;
    } catch (error) {
        if (bedrockRequired) {
            console.error('Required Bedrock voice rendering failed:', error.message);
            throw new Error('The required Bedrock voice experience is unavailable.');
        }
        console.warn('Bedrock voice rendering unavailable in local mode; using deterministic copy:', error.message);
        return fallback;
    }
}

module.exports = { renderVoiceObservation };

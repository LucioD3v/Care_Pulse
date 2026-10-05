const Alexa = require('ask-sdk-core');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { logHealthMetric, getHealthHistory, analyzeHealthTrends, triggerCaregiverAlert } = require('./mcp_client');

const VITAL_TYPES = {
    'blood pressure': { name: 'blood pressure', unit: 'mmHg' },
    'blood pressure reading': { name: 'blood pressure', unit: 'mmHg' },
    bloodpressure: { name: 'blood pressure', unit: 'mmHg' },
    bp: { name: 'blood pressure', unit: 'mmHg' },
    pressure: { name: 'blood pressure', unit: 'mmHg' },
    temperature: { name: 'temperature', unit: 'degrees Celsius' },
    'body temperature': { name: 'temperature', unit: 'degrees Celsius' },
    'heart rate': { name: 'heart rate', unit: 'beats per minute' },
    'heart rate reading': { name: 'heart rate', unit: 'beats per minute' },
    heartrate: { name: 'heart rate', unit: 'beats per minute' },
    pulse: { name: 'heart rate', unit: 'beats per minute' },
    sleep: { name: 'sleep', unit: 'hours' },
    'sleep duration': { name: 'sleep', unit: 'hours' },
    'hours of sleep': { name: 'sleep', unit: 'hours' }
};

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

function getSlotValue(handlerInput, slotName) {
    const slots = handlerInput.requestEnvelope.request.intent.slots || {};
    const slot = slots[slotName];
    if (!slot) {
        return '';
    }

    const authorities = slot.resolutions && slot.resolutions.resolutionsPerAuthority;
    if (authorities) {
        const match = authorities.find(authority => authority.status && authority.status.code === 'ER_SUCCESS_MATCH');
        const resolvedValue = match && match.values && match.values[0].value.name;
        if (resolvedValue) {
            return resolvedValue.trim();
        }
    }

    return slot.value ? String(slot.value).trim() : '';
}

function elicitSlot(handlerInput, slotName, prompt) {
    return handlerInput.responseBuilder
        .speak(prompt)
        .reprompt(prompt)
        .addElicitSlotDirective(slotName)
        .getResponse();
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function parseReading(rawValue) {
    const input = String(rawValue || '').trim().replace(/(\d+)\s+(?:point|dot)\s+(\d+)/i, '$1.$2');
    const bloodPressure = input.match(/(\d{2,3})\s*(?:over|slash|\/)\s*(\d{2,3})/i);
    if (bloodPressure) {
        return { value: Number(bloodPressure[1]), diastolic: Number(bloodPressure[2]) };
    }
    const numericValue = Number(input.replace(/,/g, '.').match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(numericValue) ? { value: numericValue } : null;
}

function temperatureCelsius(value, rawValue) {
    if (/fahrenheit|\bF\b/i.test(rawValue)) {
        return (value - 32) * 5 / 9;
    }
    return value;
}

function escapeSsml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
    })[character]);
}

async function assessRisk(metric, reading, memberName, unit, recentHistory) {
    const valueForRisk = metric.name === 'temperature'
        ? temperatureCelsius(reading.value, reading.rawValue)
        : reading.value;
    const deterministicRisk = metric.name === 'temperature' && valueForRisk > 38.5;
    const fallback = {
        alertRecommended: deterministicRisk,
        message: deterministicRisk
            ? `${memberName}'s temperature is above 38.5 degrees Celsius.`
            : 'No immediate alert threshold was reached.'
    };

    if (!process.env.BEDROCK_MODEL_ID) {
        return fallback;
    }

    try {
        const response = await bedrockClient.send(new ConverseCommand({
            modelId: process.env.BEDROCK_MODEL_ID,
            system: [{ text: 'Assess the current family health reading and recent readings conservatively. You are not a clinician: do not diagnose or recommend treatment. Recommend a caregiver alert for clearly concerning readings or worsening patterns. Never ignore deterministicAlertRequired. Reply only as JSON with alertRecommended (boolean) and message (short, calm text).' }],
            messages: [{
                role: 'user',
                content: [{ text: JSON.stringify({
                    metric: metric.name,
                    value: reading.value,
                    unit,
                    memberName,
                    deterministicAlertRequired: deterministicRisk,
                    recentReadings: recentHistory.slice(0, 20)
                }) }]
            }],
            inferenceConfig: { maxTokens: 120, temperature: 0.1 }
        }));
        const text = response.output?.message?.content?.find(item => item.text)?.text;
        const parsed = JSON.parse(text || '{}');
        return {
            alertRecommended: deterministicRisk || parsed.alertRecommended === true,
            message: typeof parsed.message === 'string' ? parsed.message : fallback.message
        };
    } catch (error) {
        console.warn('Bedrock assessment unavailable; using deterministic threshold:', error.message);
        return fallback;
    }
}

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speakOutput = '<speak>Welcome to Care Pulse. I can help you log a family member\'s vital signs, check health trends, or contact a caregiver. What would you like to do?</speak>';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt('You can say, log a vital sign, check my health trends, or request a caregiver alert.')
            .getResponse();
    }
};

const LogVitalIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'LogVitalIntent';
    },
    async handle(handlerInput) {
        const metricInput = getSlotValue(handlerInput, 'vitalType').toLowerCase();
        const metric = VITAL_TYPES[metricInput];
        if (!metric) {
            return elicitSlot(handlerInput, 'vitalType', 'Which vital sign would you like to report: blood pressure, temperature, heart rate, or sleep?');
        }

        const rawValue = getSlotValue(handlerInput, 'value');
        const reading = parseReading(rawValue);
        if (!reading || reading.value <= 0 || (reading.diastolic && reading.diastolic <= 0)) {
            return elicitSlot(handlerInput, 'value', `What is the ${metric.name} reading? For blood pressure, say both numbers, such as 120 over 80.`);
        }

        reading.rawValue = rawValue;
        const memberName = getSlotValue(handlerInput, 'memberName') || 'you';
        const unit = metric.name === 'temperature' && /fahrenheit|degrees?\s*f\b/i.test(rawValue)
            ? 'degrees Fahrenheit'
            : metric.unit;
        await logHealthMetric({
            type: metric.name,
            value: reading.diastolic ? `${reading.value}/${reading.diastolic}` : reading.value,
            unit,
            date: new Date().toISOString(),
            memberName
        });
        const recentHistory = await getHealthHistory({ memberName, timeframe: 'this week', limit: 20 });
        const risk = await assessRisk(metric, reading, memberName, unit, recentHistory);
        let alertResult;
        if (risk.alertRecommended) {
            alertResult = await triggerCaregiverAlert({
                memberName,
                metric: metric.name,
                value: reading.diastolic ? `${reading.value}/${reading.diastolic}` : reading.value,
                unit,
                message: risk.message
            });
        }

        const valueSpeech = reading.diastolic
            ? `${formatNumber(reading.value)} over ${formatNumber(reading.diastolic)} ${unit}`
            : `${formatNumber(reading.value)} ${unit}`;
        const confirmation = risk.alertRecommended
            ? alertResult.sent
                ? `I have recorded ${memberName}'s ${metric.name} as ${valueSpeech}. This reading may need attention, and I have sent an alert to the caregiver notification service. Please confirm they received it.`
                : `I have recorded ${memberName}'s ${metric.name} as ${valueSpeech}. This reading may need attention, but I could not send the caregiver alert. Please contact them directly.`
            : `I have recorded ${memberName}'s ${metric.name} as ${valueSpeech}.`;
        return handlerInput.responseBuilder.speak(`<speak>${escapeSsml(confirmation)}</speak>`).getResponse();
    }
};

const CheckTrendsIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CheckTrendsIntent';
    },
    async handle(handlerInput) {
        const memberName = getSlotValue(handlerInput, 'memberName') || 'you';
        const timeframe = getSlotValue(handlerInput, 'timeframe');
        const history = await getHealthHistory({ memberName, timeframe: timeframe || 'this week' });
        const trends = await analyzeHealthTrends({ memberName, timeframe: timeframe || 'this week', history });
        const summary = await summarizeWithBedrock(memberName, timeframe || 'this week', trends);
        return handlerInput.responseBuilder
            .speak(`<speak>${escapeSsml(summary)}</speak>`)
            .getResponse();
    }
};

async function summarizeWithBedrock(memberName, timeframe, trends) {
    if (!process.env.BEDROCK_MODEL_ID || !trends.length) {
        return trends.length
            ? `For ${memberName}, ${timeframe}: ${trends.join('. ')}.`
            : `I don’t have enough recent readings for ${memberName} to summarize ${timeframe} yet. You can log a new reading whenever you’re ready.`;
    }

    try {
        const response = await bedrockClient.send(new ConverseCommand({
            modelId: process.env.BEDROCK_MODEL_ID,
            system: [{ text: 'Summarize health measurement trends in one or two calm sentences. Do not diagnose or recommend treatment. State when there is not enough data.' }],
            messages: [{ role: 'user', content: [{ text: JSON.stringify({ memberName, timeframe, trends }) }] }],
            inferenceConfig: { maxTokens: 120, temperature: 0.3 }
        }));
        return response.output?.message?.content?.find(item => item.text)?.text
            || `I found ${trends.length} recent health observations for ${memberName}.`;
    } catch (error) {
        console.warn('Bedrock trend summary unavailable; using local summary:', error.message);
        return `For ${memberName}, ${timeframe}: ${trends.join('. ')}.`;
    }
}

const CaregiverAlertHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'TriggerAlertIntent';
    },
    async handle(handlerInput) {
        const memberName = getSlotValue(handlerInput, 'memberName') || 'your family member';
        const result = await triggerCaregiverAlert({ memberName, message: 'Caregiver alert requested by voice.' });
        const speakOutput = result.sent
            ? `I’ve sent a caregiver alert for ${memberName}. Please confirm they received it. If this is an immediate emergency, call your local emergency number now.`
            : `I’m unable to reach the caregiver notification service right now. If someone is in immediate danger, call your local emergency number now.`;
        return handlerInput.responseBuilder
            .speak(`<speak>${escapeSsml(speakOutput)}</speak>`)
            .getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can say, log Lía’s temperature as 38.8, check Dad’s health trends this week, or send a caregiver alert.';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt('Would you like to log a vital sign, check health trends, or alert a caregiver?')
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('<speak>Take care. I’m here if you need me.</speak>')
            .getResponse();
    }
};

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'I can help log a vital sign, check health trends, or alert a caregiver. Which would you like?';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder.getResponse();
    }
};

const CatchAllExceptionHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        console.error('Care Pulse request failed:', error);
        const speakOutput = 'I am sorry, something went wrong. Please try again in a moment.';
        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        LogVitalIntentHandler,
        CheckTrendsIntentHandler,
        CaregiverAlertHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler
    )
    .addErrorHandlers(CatchAllExceptionHandler)
    .lambda();

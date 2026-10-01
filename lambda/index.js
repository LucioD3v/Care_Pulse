const Alexa = require('ask-sdk-core');

const VITAL_TYPES = {
    'blood pressure': { name: 'blood pressure', unit: 'millimeters of mercury' },
    'blood pressure reading': { name: 'blood pressure', unit: 'millimeters of mercury' },
    bloodpressure: { name: 'blood pressure', unit: 'millimeters of mercury' },
    bp: { name: 'blood pressure', unit: 'millimeters of mercury' },
    pressure: { name: 'blood pressure', unit: 'millimeters of mercury' },
    temperature: { name: 'temperature', unit: 'degrees' },
    'body temperature': { name: 'temperature', unit: 'degrees' },
    'heart rate': { name: 'heart rate', unit: 'beats per minute' },
    'heart rate reading': { name: 'heart rate', unit: 'beats per minute' },
    heartrate: { name: 'heart rate', unit: 'beats per minute' },
    pulse: { name: 'heart rate', unit: 'beats per minute' },
    sleep: { name: 'sleep', unit: 'hours' },
    'sleep duration': { name: 'sleep', unit: 'hours' },
    'hours of sleep': { name: 'sleep', unit: 'hours' }
};

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

    return slot.value ? slot.value.trim() : '';
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

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        const speakOutput = 'Welcome to Care Pulse. I can help you report a vital sign, ask about health trends, or request a caregiver alert. What would you like to do?';
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
    handle(handlerInput) {
        const metricInput = getSlotValue(handlerInput, 'metricType').toLowerCase();
        const metric = VITAL_TYPES[metricInput];
        if (!metric) {
            return elicitSlot(handlerInput, 'metricType', 'Which vital sign would you like to report: blood pressure, temperature, heart rate, or sleep?');
        }

        const value = Number(getSlotValue(handlerInput, 'value'));
        if (!Number.isFinite(value) || value <= 0) {
            return elicitSlot(handlerInput, 'value', `What is the ${metric.name} reading?`);
        }

        const suppliedUnit = getSlotValue(handlerInput, 'unit');
        const temperatureUnit = suppliedUnit.toLowerCase();
        if (metric.name === 'temperature'
            && !['celsius', 'degrees celsius', 'centigrade', 'fahrenheit', 'degrees fahrenheit'].includes(temperatureUnit)) {
            return elicitSlot(handlerInput, 'unit', 'Is that temperature in Celsius or Fahrenheit?');
        }

        if (metric.name === 'blood pressure') {
            const diastolic = Number(getSlotValue(handlerInput, 'diastolic'));
            if (!Number.isFinite(diastolic) || diastolic <= 0) {
                return elicitSlot(handlerInput, 'diastolic', 'What is the bottom number of the blood pressure reading?');
            }

            return handlerInput.responseBuilder
                .speak(`I heard blood pressure ${formatNumber(value)} over ${formatNumber(diastolic)} millimeters of mercury. Health readings are not connected to storage yet, so this has not been saved.`)
                .getResponse();
        }

        const unit = metric.name === 'temperature'
            ? temperatureUnit.includes('fahrenheit') ? 'degrees Fahrenheit' : 'degrees Celsius'
            : metric.unit;
        return handlerInput.responseBuilder
            .speak(`I heard ${metric.name}, ${formatNumber(value)} ${unit}. Health readings are not connected to storage yet, so this has not been saved.`)
            .getResponse();
    }
};

const CheckTrendsIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CheckTrendsIntent';
    },
    handle(handlerInput) {
        const timeframe = getSlotValue(handlerInput, 'timeframe');
        const period = timeframe ? ` for ${timeframe}` : '';
        return handlerInput.responseBuilder
            .speak(`I can't access health trends${period} yet because health history is not connected. Once it is, I can summarize changes for you.`)
            .getResponse();
    }
};

const EmergencyAlertIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'EmergencyAlertIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('Caregiver alerts are not connected yet, so I have not sent an alert. If someone is in immediate danger or needs urgent medical help, call your local emergency number now.')
            .getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can say, log my temperature, check my health trends, or alert my caregiver. Health history and caregiver alerts are not connected yet.';
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
            .speak('Take care. I am here if you need me.')
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

const ErrorHandler = {
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
        EmergencyAlertIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler
    )
    .addErrorHandlers(ErrorHandler)
    .lambda();

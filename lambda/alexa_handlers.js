'use strict';

const { createHash } = require('node:crypto');
const Alexa = require('ask-sdk-core');
const {
    callTool,
    getCareContext,
    updateCarePreferences,
    getPendingFollowup,
    completeFollowup,
    evaluateAlertPolicy
} = require('./care_service');
const { renderVoiceObservation } = require('./voice_agent');
const { escapeSsml, localDateTime, addOneDay } = require('./voice_format');
const { CARD_TITLES, CARD_CONTENT, ALERT_STATUS, COPY } = require('./voice_copy');
const { createGetWellnessSummaryHandler } = require('./handlers/getWellnessSummaryHandler');

const STATES = {
    AWAITING_FOLLOWUP_CONFIRMATION: 'AWAITING_FOLLOWUP_CONFIRMATION',
    AWAITING_CONSENT_CONFIRMATION: 'AWAITING_CONSENT_CONFIRMATION',
    AWAITING_FOLLOWUP_STATUS: 'AWAITING_FOLLOWUP_STATUS'
};

function getSlotValue(handlerInput, slotName) {
    const slot = handlerInput.requestEnvelope.request.intent?.slots?.[slotName];
    if (!slot) {
        return '';
    }
    const match = slot.resolutions?.resolutionsPerAuthority
        ?.find(authority => authority.status?.code === 'ER_SUCCESS_MATCH');
    return String(match?.values?.[0]?.value?.name || slot.value || '').trim();
}

function ownerId(handlerInput) {
    if (process.env.DEMO_OWNER_ID) {
        return process.env.DEMO_OWNER_ID;
    }
    const rawUserId = handlerInput.requestEnvelope.context?.System?.user?.userId
        || handlerInput.requestEnvelope.session?.user?.userId
        || 'anonymous-demo-user';
    return createHash('sha256').update(rawUserId).digest('hex').slice(0, 32);
}

function defaultMemberName() {
    return process.env.DEFAULT_MEMBER_NAME || 'Elena';
}

function speakText(handlerInput, value) {
    return handlerInput.responseBuilder.speak(`<speak>${escapeSsml(value)}</speak>`);
}

function repromptText(handlerInput, value) {
    return handlerInput.responseBuilder.reprompt(`<speak>${escapeSsml(value)}</speak>`);
}

function followupSchedule(handlerInput, dueTime = '18:00', timezone = process.env.DEFAULT_TIME_ZONE || 'America/Mexico_City') {
    const requestDate = new Date(handlerInput.requestEnvelope.request.timestamp || Date.now());
    const local = localDateTime(requestDate, timezone);
    return {
        dueDate: dueTime > local.time ? local.date : addOneDay(local.date),
        dueTime
    };
}

function sessionAttributes(handlerInput) {
    return handlerInput.attributesManager.getSessionAttributes();
}

function saveConversationState(handlerInput, values) {
    handlerInput.attributesManager.setSessionAttributes({
        ...sessionAttributes(handlerInput),
        ...values
    });
}

function elicitSlot(handlerInput, slotName, prompt) {
    speakText(handlerInput, prompt);
    return repromptText(handlerInput, prompt)
        .addElicitSlotDirective(slotName)
        .getResponse();
}

async function tracedTool(name, input) {
    const startedAt = Date.now();
    const result = await callTool(name, input);
    console.info(JSON.stringify({
        event: 'mcp_tool_completed',
        tool: name,
        durationMs: Date.now() - startedAt,
        ownerId: input.ownerId,
        memberName: input.memberName,
        outcome: result?.source || result?.reason || 'ok'
    }));
    return result;
}

async function ensureFollowup(handlerInput, { memberName, signal, dueTime }) {
    const userOwnerId = ownerId(handlerInput);
    const existing = await getPendingFollowup({ ownerId: userOwnerId, memberName });
    if (existing) {
        return existing;
    }
    const context = await getCareContext({ ownerId: userOwnerId, memberName });
    const schedule = followupSchedule(handlerInput, dueTime || context.preferredFollowupTime || '18:00', context.timezone);
    return tracedTool('create_followup', {
        ownerId: userOwnerId,
        memberName,
        signal,
        ...schedule
    });
}

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    async handle(handlerInput) {
        const userOwnerId = ownerId(handlerInput);
        const memberName = defaultMemberName();
        const context = await getCareContext({ ownerId: userOwnerId, memberName });
        const now = localDateTime(new Date(handlerInput.requestEnvelope.request.timestamp || Date.now()), context.timezone);
        const dueFollowup = await getPendingFollowup({
            ownerId: userOwnerId,
            memberName,
            dueOnly: true,
            localDate: now.date,
            localTime: now.time
        });
        if (dueFollowup) {
            saveConversationState(handlerInput, {
                conversationState: STATES.AWAITING_FOLLOWUP_STATUS,
                memberName,
                signal: dueFollowup.signal,
                followupId: dueFollowup.followupId
            });
            const prompt = COPY.dueFollowup(memberName);
            speakText(handlerInput, prompt);
            return repromptText(handlerInput, prompt).getResponse();
        }
        speakText(handlerInput, COPY.welcome);
        return repromptText(handlerInput, COPY.welcome).getResponse();
    }
};

const ReportWellnessIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ReportWellnessIntent';
    },
    async handle(handlerInput) {
        const sleepHours = getSlotValue(handlerInput, 'sleepHours');
        const signal = (getSlotValue(handlerInput, 'wellnessSignal') || (sleepHours ? 'sleep' : '')).toLowerCase();
        if (!signal) {
            return elicitSlot(handlerInput, 'wellnessSignal', COPY.missingSignal);
        }
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const state = getSlotValue(handlerInput, 'intensity') || (sleepHours ? 'reported' : 'more than usual');
        const userOwnerId = ownerId(handlerInput);
        const context = await tracedTool('get_care_context', { ownerId: userOwnerId, memberName });
        await tracedTool('log_wellness_event', {
            ownerId: userOwnerId,
            memberName,
            signal,
            state,
            details: sleepHours ? `${sleepHours} hours` : '',
            ...(sleepHours ? { numericValue: Number(sleepHours) } : {})
        });
        const comparison = await tracedTool('compare_with_baseline', {
            ownerId: userOwnerId,
            memberName,
            signal
        });
        const observation = await renderVoiceObservation({ memberName, signal, comparison });
        if (context.followupOffers === 'off') {
            saveConversationState(handlerInput, { conversationState: null });
            return speakText(handlerInput, COPY.reportSavedWithoutOffer(observation))
                .withSimpleCard(CARD_TITLES.wellness, CARD_CONTENT.wellness(memberName, signal, comparison.summary))
                .getResponse();
        }
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_FOLLOWUP_CONFIRMATION,
            memberName,
            signal
        });
        const followupTime = context.preferredFollowupTime || '18:00';
        const prompt = `${observation} ${COPY.followupQuestion(followupTime)}`;
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, COPY.followupReprompt(followupTime))
            .withSimpleCard(CARD_TITLES.wellness, CARD_CONTENT.wellness(memberName, signal, comparison.summary))
            .getResponse();
    }
};

const ScheduleFollowupIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ScheduleFollowupIntent';
    },
    async handle(handlerInput) {
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const signal = getSlotValue(handlerInput, 'wellnessSignal') || 'tiredness';
        const dueTime = getSlotValue(handlerInput, 'followupTime') || undefined;
        const followup = await ensureFollowup(handlerInput, { memberName, signal, dueTime });
        const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName });
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
            memberName,
            caregiverName: context.caregiverName,
            signal,
            followupId: followup.followupId
        });
        const prompt = COPY.scheduleAndConsent(followup.dueTime, context.caregiverName, signal);
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, prompt).getResponse();
    }
};

const ConfigureCaregiverAlertIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'ConfigureCaregiverAlertIntent';
    },
    async handle(handlerInput) {
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const signal = getSlotValue(handlerInput, 'wellnessSignal') || sessionAttributes(handlerInput).signal || 'tiredness';
        const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName });
        const caregiverName = getSlotValue(handlerInput, 'caregiverName') || context.caregiverName;
        const followup = await ensureFollowup(handlerInput, { memberName, signal });
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
            memberName,
            caregiverName,
            signal,
            followupId: followup.followupId
        });
        const prompt = COPY.consentIntroduction(caregiverName, signal);
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, prompt).getResponse();
    }
};

const CompleteFollowupIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CompleteFollowupIntent';
    },
    async handle(handlerInput) {
        const followupStatus = getSlotValue(handlerInput, 'followupStatus').toLowerCase();
        if (!followupStatus) {
            return elicitSlot(handlerInput, 'followupStatus', COPY.missingStatus);
        }
        const attributes = sessionAttributes(handlerInput);
        const memberName = getSlotValue(handlerInput, 'memberName') || attributes.memberName || defaultMemberName();
        const userOwnerId = ownerId(handlerInput);
        const followup = await getPendingFollowup({ ownerId: userOwnerId, memberName });
        if (!followup) {
            return speakText(handlerInput, COPY.noPending(memberName)).getResponse();
        }
        await tracedTool('log_wellness_event', {
            ownerId: userOwnerId,
            memberName,
            signal: followup.signal,
            state: followupStatus,
            details: 'scheduled follow-up response'
        });
        await completeFollowup({ followup, status: followupStatus });
        const context = await getCareContext({ ownerId: userOwnerId, memberName });
        const decision = await evaluateAlertPolicy({
            ownerId: userOwnerId,
            memberName,
            caregiverName: context.caregiverName,
            signal: followup.signal,
            followupId: followup.followupId,
            followupStatus
        });
        let speech;
        let alertStatus = ALERT_STATUS.notNeeded;
        if (decision.allowed) {
            const alert = await tracedTool('send_caregiver_alert', {
                ownerId: userOwnerId,
                memberName,
                caregiverName: context.caregiverName,
                signal: followup.signal,
                followupStatus,
                consentId: decision.consentId,
                authorized: true
            });
            alertStatus = alert.sent ? ALERT_STATUS.sent(context.caregiverName) : ALERT_STATUS.simulated;
            speech = alert.sent ? COPY.alertSent(context.caregiverName) : COPY.alertUnavailable(context.caregiverName);
        } else if (decision.reason === 'consent_missing_or_expired') {
            alertStatus = ALERT_STATUS.noConsent;
            speech = COPY.noPermission;
        } else {
            speech = COPY.noAlert(followupStatus);
        }
        return speakText(handlerInput, speech)
            .withSimpleCard(CARD_TITLES.followup, CARD_CONTENT.followup(memberName, followupStatus, alertStatus))
            .getResponse();
    }
};

const GetWellnessSummaryIntentHandler = createGetWellnessSummaryHandler({
    getSlotValue,
    ownerId,
    defaultMemberName,
    speakText
});

const SetCarePreferencesIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'SetCarePreferencesIntent';
    },
    async handle(handlerInput) {
        const summaryLength = getSlotValue(handlerInput, 'summaryLength').toLowerCase() || undefined;
        const preferredFollowupTime = getSlotValue(handlerInput, 'preferredFollowupTime') || undefined;
        const followupOffers = getSlotValue(handlerInput, 'followupOffers').toLowerCase() || undefined;
        if (!summaryLength && !preferredFollowupTime && !followupOffers) {
            speakText(handlerInput, COPY.preferenceHelp);
            return repromptText(handlerInput, COPY.preferenceHelp).getResponse();
        }
        if (summaryLength && !['short', 'detailed'].includes(summaryLength)) {
            speakText(handlerInput, COPY.preferenceInvalidLength);
            return repromptText(handlerInput, COPY.preferenceInvalidLength).getResponse();
        }
        if (followupOffers && !['on', 'off'].includes(followupOffers)) {
            speakText(handlerInput, COPY.preferenceInvalidOffers);
            return repromptText(handlerInput, COPY.preferenceInvalidOffers).getResponse();
        }
        if (preferredFollowupTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferredFollowupTime)) {
            speakText(handlerInput, COPY.preferenceInvalidTime);
            return repromptText(handlerInput, COPY.preferenceInvalidTime).getResponse();
        }
        const memberName = defaultMemberName();
        await updateCarePreferences({
            ownerId: ownerId(handlerInput),
            memberName,
            summaryLength,
            preferredFollowupTime,
            followupOffers
        });
        const changes = [];
        if (summaryLength) changes.push(`${summaryLength} summaries`);
        if (preferredFollowupTime) changes.push(COPY.preferenceTime(preferredFollowupTime));
        if (followupOffers) changes.push(`follow-up suggestions ${followupOffers}`);
        return speakText(handlerInput, COPY.preferenceSaved(changes)).getResponse();
    }
};

const YesIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
    },
    async handle(handlerInput) {
        const attributes = sessionAttributes(handlerInput);
        if (attributes.conversationState === STATES.AWAITING_FOLLOWUP_CONFIRMATION) {
            const followup = await ensureFollowup(handlerInput, {
                memberName: attributes.memberName,
                signal: attributes.signal
            });
            const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName: attributes.memberName });
            saveConversationState(handlerInput, {
                conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
                caregiverName: context.caregiverName,
                followupId: followup.followupId
            });
            const prompt = COPY.scheduleAndConsent(followup.dueTime, context.caregiverName, attributes.signal);
            speakText(handlerInput, prompt);
            return repromptText(handlerInput, prompt).getResponse();
        }
        if (attributes.conversationState === STATES.AWAITING_CONSENT_CONFIRMATION) {
            await tracedTool('request_consent', {
                ownerId: ownerId(handlerInput),
                memberName: attributes.memberName,
                caregiverName: attributes.caregiverName,
                signal: attributes.signal,
                followupId: attributes.followupId
            });
            return speakText(handlerInput, COPY.consentSaved(attributes.caregiverName))
                .withSimpleCard(CARD_TITLES.permission, CARD_CONTENT.permission(attributes.caregiverName, attributes.signal))
                .getResponse();
        }
        speakText(handlerInput, COPY.yesWithoutContext);
        return repromptText(handlerInput, COPY.yesWithoutContext).getResponse();
    }
};

const NoIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent';
    },
    handle(handlerInput) {
        const state = sessionAttributes(handlerInput).conversationState;
        if (state === STATES.AWAITING_FOLLOWUP_CONFIRMATION) {
            return speakText(handlerInput, COPY.followupDeclined).getResponse();
        }
        if (state === STATES.AWAITING_CONSENT_CONFIRMATION) {
            return speakText(handlerInput, COPY.consentDeclined).getResponse();
        }
        return speakText(handlerInput, COPY.okay).getResponse();
    }
};

const EmergencyGuidanceIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'EmergencyGuidanceIntent';
    },
    handle(handlerInput) {
        return speakText(handlerInput, COPY.emergency).getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        speakText(handlerInput, COPY.help);
        return repromptText(handlerInput, COPY.help).getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
    },
    handle(handlerInput) {
        return speakText(handlerInput, COPY.goodbye).getResponse();
    }
};

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        speakText(handlerInput, COPY.fallback);
        return repromptText(handlerInput, COPY.fallback).getResponse();
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
        console.error('CarePulse request failed:', error);
        speakText(handlerInput, COPY.error);
        return repromptText(handlerInput, COPY.error).getResponse();
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        ReportWellnessIntentHandler,
        ScheduleFollowupIntentHandler,
        ConfigureCaregiverAlertIntentHandler,
        CompleteFollowupIntentHandler,
        GetWellnessSummaryIntentHandler,
        SetCarePreferencesIntentHandler,
        YesIntentHandler,
        NoIntentHandler,
        EmergencyGuidanceIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler
    )
    .addErrorHandlers(CatchAllExceptionHandler)
    .lambda();

exports._private = { ownerId, localDateTime, followupSchedule, STATES };

function timeframeStart(timeframe, now = new Date()) {
    if (timeframe === 'today') {
        const start = new Date(now);
        start.setUTCHours(0, 0, 0, 0);
        return start;
    }
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

function summarizeVitals(readings, timeframe) {
    if (!readings.length) {
        return `I couldn't find any health readings for ${timeframe}.`;
    }
    const groups = {};
    for (const reading of readings) {
        if (!groups[reading.Metric]) {
            groups[reading.Metric] = { values: [], unit: reading.Unit };
        }
        groups[reading.Metric].values.push(reading.Value);
    }
    const count = readings.length;
    const parts = Object.entries(groups).map(([metric, { values, unit }]) => {
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        return `average ${metric} was ${avg} ${unit}`;
    });
    return `I found ${count} readings. ${parts.join(', ')}. This is not medical advice.`;
}

exports._test = { timeframeStart, summarizeVitals };

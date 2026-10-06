'use strict';

const { createHash } = require('node:crypto');
const Alexa = require('ask-sdk-core');
const {
    callTool,
    getCareContext,
    getPendingFollowup,
    completeFollowup,
    evaluateAlertPolicy,
    getWellnessSnapshot
} = require('./mcp_client');
const { renderVoiceObservation } = require('./voice_agent');

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

function escapeSsml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character]);
}

function localDateTime(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {});
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`
    };
}

function addOneDay(dateText) {
    const date = new Date(`${dateText}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
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
    return handlerInput.responseBuilder
        .speak(prompt)
        .reprompt(prompt)
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

async function ensureFollowup(handlerInput, { memberName, signal, dueTime = '18:00' }) {
    const userOwnerId = ownerId(handlerInput);
    const existing = await getPendingFollowup({ ownerId: userOwnerId, memberName });
    if (existing) {
        return existing;
    }
    const context = await getCareContext({ ownerId: userOwnerId, memberName });
    const schedule = followupSchedule(handlerInput, dueTime, context.timezone);
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
            const prompt = `${memberName}, we planned to check how you were feeling. Do you feel better, the same, or worse?`;
            return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
        }
        const prompt = 'Welcome to Care Pulse. You can tell me how you feel, ask for a wellness summary, or schedule a check-in. How can I help?';
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
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
            return elicitSlot(handlerInput, 'wellnessSignal', 'What would you like me to record, for example tiredness, sleep, mood, or appetite?');
        }
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const state = getSlotValue(handlerInput, 'intensity') || (sleepHours ? 'reported' : 'more than usual');
        const userOwnerId = ownerId(handlerInput);
        await tracedTool('get_care_context', { ownerId: userOwnerId, memberName });
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
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_FOLLOWUP_CONFIRMATION,
            memberName,
            signal
        });
        const observation = await renderVoiceObservation({ memberName, signal, comparison });
        const prompt = `${observation} Would you like me to check in again at six?`;
        return handlerInput.responseBuilder
            .speak(`<speak>${escapeSsml(prompt)}</speak>`)
            .reprompt('Would you like a follow-up at six?')
            .withSimpleCard('CarePulse wellness check', `${memberName}: ${signal}\n${comparison.summary}`)
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
        const dueTime = getSlotValue(handlerInput, 'followupTime') || '18:00';
        const followup = await ensureFollowup(handlerInput, { memberName, signal, dueTime });
        const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName });
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
            memberName,
            caregiverName: context.caregiverName,
            signal,
            followupId: followup.followupId
        });
        const prompt = `The check-in is scheduled for ${dueTime}. Do you authorize ${context.caregiverName} to receive a brief alert only if you report ${signal.replace(/-/g, ' ')} again during this follow-up?`;
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
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
        const prompt = `Before I share anything, do you authorize ${caregiverName} to receive a brief alert only if you report ${signal.replace(/-/g, ' ')} again during this follow-up?`;
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
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
            return elicitSlot(handlerInput, 'followupStatus', 'Do you feel better, the same, or worse?');
        }
        const attributes = sessionAttributes(handlerInput);
        const memberName = getSlotValue(handlerInput, 'memberName') || attributes.memberName || defaultMemberName();
        const userOwnerId = ownerId(handlerInput);
        const followup = await getPendingFollowup({ ownerId: userOwnerId, memberName });
        if (!followup) {
            return handlerInput.responseBuilder
                .speak(`I do not have a pending check-in for ${memberName}. You can ask me to schedule one.`)
                .getResponse();
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
        let alertStatus = 'No alert needed';
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
            alertStatus = alert.sent ? `${context.caregiverName} notified` : 'Notification simulated';
            speech = alert.sent
                ? `Thank you. I recorded the follow-up and sent ${context.caregiverName} the brief alert you authorized.`
                : `Thank you. I recorded the follow-up. The authorized alert was prepared, but the notification service is not configured, so please contact ${context.caregiverName} directly.`;
        } else if (decision.reason === 'consent_missing_or_expired') {
            alertStatus = 'Not shared: no active consent';
            speech = `Thank you. I recorded the follow-up, but I did not share it because there is no active permission.`;
        } else {
            speech = `Thank you. I recorded that you feel ${followupStatus}. No caregiver alert was needed.`;
        }
        return handlerInput.responseBuilder
            .speak(speech)
            .withSimpleCard('Family Wellness Snapshot', `${memberName}\nFollow-up: completed\nStatus: ${followupStatus}\nCare Circle: ${alertStatus}`)
            .getResponse();
    }
};

const GetWellnessSummaryIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetWellnessSummaryIntent';
    },
    async handle(handlerInput) {
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const timeframe = getSlotValue(handlerInput, 'timeframe') || 'this week';
        const snapshot = await getWellnessSnapshot({ ownerId: ownerId(handlerInput), memberName, timeframe });
        const signalText = snapshot.signals.length ? snapshot.signals.join(', ') : 'no recent signals';
        const speech = `${memberName}'s ${timeframe} summary: ${snapshot.status}. I found ${snapshot.eventCount} wellness reports covering ${signalText}. Follow-up: ${snapshot.followup}.`;
        return handlerInput.responseBuilder
            .speak(speech)
            .withSimpleCard('Family Wellness Snapshot', `${memberName} · ${timeframe}\nStatus: ${snapshot.status}\nSignals: ${signalText}\nFollow-up: ${snapshot.followup}`)
            .getResponse();
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
            const prompt = `The follow-up is scheduled for six. Do you authorize ${context.caregiverName} to receive a brief alert only if you report ${attributes.signal.replace(/-/g, ' ')} again during that check-in?`;
            return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
        }
        if (attributes.conversationState === STATES.AWAITING_CONSENT_CONFIRMATION) {
            await tracedTool('request_consent', {
                ownerId: ownerId(handlerInput),
                memberName: attributes.memberName,
                caregiverName: attributes.caregiverName,
                signal: attributes.signal,
                followupId: attributes.followupId
            });
            return handlerInput.responseBuilder
                .speak(`Done. Your permission applies only to this follow-up, and no other information will be shared with ${attributes.caregiverName}.`)
                .withSimpleCard('CarePulse permission', `Shared with: ${attributes.caregiverName}\nOnly if: ${attributes.signal} repeats\nScope: this follow-up only`)
                .getResponse();
        }
        return handlerInput.responseBuilder.speak('What would you like me to help with?').reprompt('How can I help?').getResponse();
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
            return handlerInput.responseBuilder.speak('Okay. I recorded the wellness update without creating a follow-up.').getResponse();
        }
        if (state === STATES.AWAITING_CONSENT_CONFIRMATION) {
            return handlerInput.responseBuilder.speak('Okay. The follow-up remains scheduled, but I will not share it with anyone.').getResponse();
        }
        return handlerInput.responseBuilder.speak('Okay.').getResponse();
    }
};

const EmergencyGuidanceIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'EmergencyGuidanceIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('Care Pulse cannot handle emergencies. If someone may be in immediate danger, call your local emergency number now or ask a nearby person for help.')
            .getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const prompt = 'Try saying, I feel more tired than usual, schedule a check-in at six, or give me my weekly wellness summary.';
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder.speak('Take care.').getResponse();
    }
};

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const prompt = 'I can record a wellness signal, create a follow-up, or show a simple weekly summary. What would you like to do?';
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
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
        const prompt = 'I am sorry, something went wrong. Please try again.';
        return handlerInput.responseBuilder.speak(prompt).reprompt(prompt).getResponse();
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

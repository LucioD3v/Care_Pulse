'use strict';

const { createHash } = require('node:crypto');
const Alexa = require('ask-sdk-core');
const {
    callTool,
    getCareContext,
    updateCarePreferences,
    getPendingFollowup,
    getFollowupById,
    completeFollowup,
    getCompletionForRequest,
    listFollowups,
    cancelFollowup,
    rescheduleFollowup,
    correctWellnessEvent,
    revokeConsent,
    revokeMemberSharing,
    resolveCaregiver,
    evaluateAlertPolicy
} = require('./care_service');
const { renderVoiceObservation } = require('./voice_agent');
const { escapeSsml, localDateTime, addOneDay, spokenSchedule } = require('./voice_format');
const { CARD_TITLES, CARD_CONTENT, ALERT_STATUS, COPY } = require('./voice_copy');
const { createGetWellnessSummaryHandler } = require('./handlers/getWellnessSummaryHandler');
const { grantBeeConsent, revokeBeeConsent, consentDays } = require('./bee_link');
const { metric } = require('./observability');
const { currentPrincipal, defaultMember, AccessError } = require('./access_control');
const { isDemo } = require('./runtime_config');
const { SIGNALS, STATES: REPORT_STATES, normalize } = require('./care_validation');
const { addWelcomePresentation } = require('./welcome_presentation');

const STATES = {
    AWAITING_FOLLOWUP_CONFIRMATION: 'AWAITING_FOLLOWUP_CONFIRMATION',
    AWAITING_CONSENT_CONFIRMATION: 'AWAITING_CONSENT_CONFIRMATION',
    AWAITING_FOLLOWUP_STATUS: 'AWAITING_FOLLOWUP_STATUS',
    AWAITING_BEE_CONSENT: 'AWAITING_BEE_CONSENT',
    AWAITING_BEE_UNLINK_CONFIRMATION: 'AWAITING_BEE_UNLINK_CONFIRMATION',
    AWAITING_FOLLOWUP_SELECTION: 'AWAITING_FOLLOWUP_SELECTION',
    AWAITING_RESCHEDULE_TIME: 'AWAITING_RESCHEDULE_TIME'
};

function getSlotValue(handlerInput, slotName) {
    const slot = handlerInput.requestEnvelope.request.intent?.slots?.[slotName];
    if (!slot) {
        return '';
    }
    const match = slot.resolutions?.resolutionsPerAuthority
        ?.find(authority => authority.status?.code === 'ER_SUCCESS_MATCH');
    if (!match && slot.resolutions?.resolutionsPerAuthority?.some(authority => authority.status?.code === 'ER_SUCCESS_NO_MATCH')) return '';
    return String(match?.values?.[0]?.value?.name || slot.value || '').trim();
}

function getRawSlotValue(handlerInput, slotName) {
    return String(handlerInput.requestEnvelope.request.intent?.slots?.[slotName]?.value || '').trim();
}

function ownerId(handlerInput) {
    if (currentPrincipal()?.ownerId) return currentPrincipal().ownerId;
    if (process.env.DEMO_OWNER_ID && isDemo()) {
        return process.env.DEMO_OWNER_ID;
    }
    const rawUserId = handlerInput.requestEnvelope.context?.System?.user?.userId
        || handlerInput.requestEnvelope.session?.user?.userId
        || '';
    if (!rawUserId || (process.env.DEMO_OWNER_ID && !isDemo())) throw new AccessError();
    return createHash('sha256').update(rawUserId).digest('hex').slice(0, 32);
}

function defaultMemberName() {
    return defaultMember();
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

function scheduleText(handlerInput, followup, timezone) {
    return spokenSchedule(followup.dueDate, followup.dueTime,
        new Date(handlerInput.requestEnvelope.request.timestamp || Date.now()), timezone);
}

function validTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function notificationChannel(destination) {
    if (isDemo()) return 'configured demo SNS topic';
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination?.endpoint || '')) return 'verified email address';
    if (/^\+[1-9]\d{6,14}$/.test(destination?.endpoint || '')) return 'verified phone number by text message';
    return 'verified notification channel';
}

function followupLabel(followup, index) {
    return `${index + 1} for ${followup.signal.replace(/-/g, ' ')} on ${followup.dueDate} at ${followup.dueTime}`;
}

function clarification(handlerInput, followups, action, extra = {}) {
    const choices = followups.slice(0, 3);
    saveConversationState(handlerInput, { conversationState: STATES.AWAITING_FOLLOWUP_SELECTION,
        pendingAction: action, followupChoices: choices.map(item => item.followupId), ...extra });
    const prompt = COPY.followupChoice(choices.map(followupLabel));
    return repromptText(handlerInput, prompt).speak(`<speak>${escapeSsml(prompt)}</speak>`).getResponse();
}

async function selectedFollowup(handlerInput, action, memberName, extra = {}) {
    const attributes = sessionAttributes(handlerInput);
    const userOwnerId = ownerId(handlerInput);
    if (attributes.followupId && attributes.memberName === memberName
        && [STATES.AWAITING_FOLLOWUP_STATUS, STATES.AWAITING_RESCHEDULE_TIME].includes(attributes.conversationState)) {
        const selected = await getFollowupById({ ownerId: userOwnerId, memberName, followupId: attributes.followupId });
        if (selected?.status === 'pending') return selected;
    }
    const { followups } = await listFollowups({ ownerId: userOwnerId, memberName });
    if (!followups.length) return null;
    if (followups.length > 1) return clarification(handlerInput, followups, action, { memberName, ...extra });
    return followups[0];
}

function sessionAttributes(handlerInput) {
    return handlerInput.attributesManager.getSessionAttributes();
}

function saveConversationState(handlerInput, values) {
    handlerInput.attributesManager.setSessionAttributes({
        ...sessionAttributes(handlerInput),
        ...values,
        fallbackCount: values.fallbackCount ?? 0
    });
}

function elicitSlot(handlerInput, slotName, prompt) {
    speakText(handlerInput, prompt);
    return repromptText(handlerInput, prompt)
        .addElicitSlotDirective(slotName)
        .getResponse();
}

async function tracedTool(name, input, options) {
    const startedAt = Date.now();
    try {
        return await callTool(name, input, options);
    } catch (error) {
        metric('ToolErrors');
        throw error;
    } finally {
        metric('ToolDuration', Date.now() - startedAt, 'Milliseconds');
    }
}

async function ensureFollowup(handlerInput, { memberName, signal, dueTime }) {
    const userOwnerId = ownerId(handlerInput);
    const context = await getCareContext({ ownerId: userOwnerId, memberName });
    const schedule = followupSchedule(handlerInput, dueTime || context.preferredFollowupTime || '18:00', context.timezone);
    const existing = await getPendingFollowup({ ownerId: userOwnerId, memberName, signal, ...schedule });
    if (existing) {
        return existing;
    }
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
            return addWelcomePresentation(handlerInput, repromptText(handlerInput, prompt)).getResponse();
        }
        speakText(handlerInput, COPY.welcome);
        return addWelcomePresentation(handlerInput, repromptText(handlerInput, COPY.welcome)).getResponse();
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
        if (!SIGNALS.includes(normalize(signal))) {
            return elicitSlot(handlerInput, 'wellnessSignal', COPY.missingSignal);
        }
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        if (sleepHours && (!Number.isFinite(Number(sleepHours)) || Number(sleepHours) < 0 || Number(sleepHours) > 24)) {
            return elicitSlot(handlerInput, 'sleepHours', 'How many hours did you sleep, from zero to twenty-four?');
        }
        const rawSignal = getRawSlotValue(handlerInput, 'wellnessSignal').toLowerCase();
        const appetiteDirection = signal === 'appetite' && /\b(not hungry|no appetite|poor appetite|less hungry)\b/.test(rawSignal)
            ? 'less than usual' : '';
        const state = getSlotValue(handlerInput, 'intensity') || appetiteDirection || 'reported';
        if (!REPORT_STATES.includes(normalize(state))) return elicitSlot(handlerInput, 'intensity', 'Was that more than usual, less than usual, or normal?');
        const userOwnerId = ownerId(handlerInput);
        const context = await tracedTool('get_care_context', { ownerId: userOwnerId, memberName });
        const savedReport = await tracedTool('log_wellness_event', {
            ownerId: userOwnerId,
            memberName,
            signal,
            state,
            details: sleepHours ? `${sleepHours} hours` : '',
            ...(sleepHours ? { numericValue: Number(sleepHours) } : {})
        });
        saveConversationState(handlerInput, { lastReportSk: savedReport.sk, lastReportMember: memberName,
            lastReportSignal: signal });
        handlerInput.attributesManager.getRequestAttributes().reportSaved = true;
        const comparison = await tracedTool('compare_with_baseline', {
            ownerId: userOwnerId,
            memberName,
            signal
        }, { context });
        const observation = await renderVoiceObservation({ memberName, signal, comparison });
        if (context.followupOffers === 'off') {
            saveConversationState(handlerInput, { conversationState: null });
            return speakText(handlerInput, COPY.reportSavedWithoutOffer(observation))
                .withSimpleCard(CARD_TITLES.wellness, context.discreetMode === 'on' ? CARD_CONTENT.discreet
                    : CARD_CONTENT.wellness(memberName, signal, comparison.summary))
                .getResponse();
        }
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_FOLLOWUP_CONFIRMATION,
            memberName,
            signal,
            followupTime: context.preferredFollowupTime || '18:00'
        });
        const followupTime = context.preferredFollowupTime || '18:00';
        const schedule = followupSchedule(handlerInput, followupTime, context.timezone);
        const prompt = `${observation} ${COPY.followupQuestion(scheduleText(handlerInput, schedule, context.timezone))}`;
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, COPY.followupReprompt(followupTime))
            .withSimpleCard(CARD_TITLES.wellness, context.discreetMode === 'on' ? CARD_CONTENT.discreet
                : CARD_CONTENT.wellness(memberName, signal, comparison.summary))
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
        if (dueTime && !validTime(dueTime)) return elicitSlot(handlerInput, 'followupTime', COPY.followupTimeNeeded);
        const followup = await ensureFollowup(handlerInput, { memberName, signal, dueTime });
        const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName });
        const destination = await resolveCaregiver({ ownerId: ownerId(handlerInput), memberName,
            caregiverName: context.caregiverName });
        const channel = notificationChannel(destination);
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
            memberName,
            caregiverName: context.caregiverName,
            signal,
            followupId: followup.followupId,
            notificationChannel: channel
        });
        const prompt = COPY.scheduleAndConsent(followup.dueTime, context.caregiverName, signal, followup.dueDate,
            scheduleText(handlerInput, followup, context.timezone), channel);
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
        const destination = await resolveCaregiver({ ownerId: ownerId(handlerInput), memberName, caregiverName });
        const followup = await ensureFollowup(handlerInput, { memberName, signal });
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
            memberName,
            caregiverName,
            signal,
            followupId: followup.followupId,
            notificationChannel: notificationChannel(destination)
        });
        const prompt = COPY.consentIntroduction(caregiverName, signal, notificationChannel(destination));
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
        if (!['better', 'same', 'worse'].includes(followupStatus)) {
            return elicitSlot(handlerInput, 'followupStatus', COPY.missingStatus);
        }
        const attributes = sessionAttributes(handlerInput);
        const memberName = getSlotValue(handlerInput, 'memberName') || attributes.memberName || defaultMemberName();
        const userOwnerId = ownerId(handlerInput);
        const replay = await getCompletionForRequest({ ownerId: userOwnerId, memberName });
        const followup = replay || await selectedFollowup(handlerInput, 'complete', memberName, { pendingStatus: followupStatus });
        if (followup && !followup.followupId) return followup;
        if (!followup || (!replay && followup.status !== 'pending')) {
            return speakText(handlerInput, COPY.noPending(memberName)).getResponse();
        }
        await completeFollowup({ followup, status: followupStatus });
        saveConversationState(handlerInput, { conversationState: null, followupId: null, followupChoices: null });
        handlerInput.attributesManager.getRequestAttributes().reportSaved = true;
        const context = await getCareContext({ ownerId: userOwnerId, memberName });
        const caregiverName = followup.caregiverName || context.caregiverName;
        const decision = await evaluateAlertPolicy({
            ownerId: userOwnerId,
            memberName,
            caregiverName,
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
                caregiverName,
                signal: followup.signal,
                followupStatus,
                consentId: decision.consentId
            });
            alertStatus = alert.sent ? ALERT_STATUS.sent(caregiverName)
                : alert.simulated ? ALERT_STATUS.simulated : ALERT_STATUS.failed;
            speech = alert.sent ? COPY.alertSent(caregiverName)
                : alert.status === 'unknown' ? COPY.alertUnknown(caregiverName) : COPY.alertUnavailable(caregiverName);
        } else if (decision.reason === 'consent_missing_or_expired') {
            alertStatus = ALERT_STATUS.noConsent;
            speech = COPY.noPermission;
        } else {
            speech = COPY.noAlert(followupStatus);
        }
        return speakText(handlerInput, speech)
            .withSimpleCard(CARD_TITLES.followup, context.discreetMode === 'on' ? CARD_CONTENT.discreet
                : CARD_CONTENT.followup(memberName, followupStatus, alertStatus))
            .getResponse();
    }
};

async function finishFollowupAction(handlerInput, followup, action, dueTime, status) {
    const userOwnerId = ownerId(handlerInput);
    const context = await getCareContext({ ownerId: userOwnerId, memberName: followup.memberName });
    if (action === 'cancel') {
        await cancelFollowup({ ownerId: userOwnerId, memberName: followup.memberName, followupId: followup.followupId });
        saveConversationState(handlerInput, { conversationState: null, followupId: null, followupChoices: null });
        return speakText(handlerInput, COPY.followupCancelled(scheduleText(handlerInput, followup, context.timezone))).getResponse();
    }
    if (action === 'reschedule') {
        if (!validTime(dueTime)) {
            saveConversationState(handlerInput, { conversationState: STATES.AWAITING_RESCHEDULE_TIME,
                followupId: followup.followupId, memberName: followup.memberName });
            return repromptText(handlerInput, COPY.followupTimeNeeded)
                .speak(`<speak>${escapeSsml(COPY.followupTimeNeeded)}</speak>`).getResponse();
        }
        const schedule = followupSchedule(handlerInput, dueTime, context.timezone);
        const moved = await rescheduleFollowup({ ownerId: userOwnerId, memberName: followup.memberName,
            followupId: followup.followupId, ...schedule });
        saveConversationState(handlerInput, { conversationState: null, followupId: null, followupChoices: null });
        return speakText(handlerInput, COPY.followupRescheduled(scheduleText(handlerInput, moved, context.timezone))).getResponse();
    }
    saveConversationState(handlerInput, { conversationState: STATES.AWAITING_FOLLOWUP_STATUS,
        followupId: followup.followupId, memberName: followup.memberName, followupChoices: null });
    if (status) {
        handlerInput.requestEnvelope.request.intent.name = 'CompleteFollowupIntent';
        handlerInput.requestEnvelope.request.intent.slots.followupStatus = { name: 'followupStatus', value: status };
        return CompleteFollowupIntentHandler.handle(handlerInput);
    }
    const prompt = COPY.dueFollowup(followup.memberName);
    return repromptText(handlerInput, prompt).speak(`<speak>${escapeSsml(prompt)}</speak>`).getResponse();
}

const ManageFollowupIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && ['ListFollowupsIntent', 'CancelFollowupIntent', 'RescheduleFollowupIntent', 'SelectFollowupIntent']
                .includes(Alexa.getIntentName(handlerInput.requestEnvelope));
    },
    async handle(handlerInput) {
        const intent = Alexa.getIntentName(handlerInput.requestEnvelope);
        const attributes = sessionAttributes(handlerInput);
        const memberName = getSlotValue(handlerInput, 'memberName') || attributes.memberName || defaultMemberName();
        const userOwnerId = ownerId(handlerInput);
        if (intent === 'ListFollowupsIntent') {
            const { followups } = await listFollowups({ ownerId: userOwnerId, memberName });
            if (!followups.length) return speakText(handlerInput, COPY.followupNone).getResponse();
            const labels = followups.slice(0, 3).map(followupLabel);
            const prompt = `${followups.length} pending check-ins: ${labels.join('; ')}. You can say cancel or move a check-in.`;
            return speakText(handlerInput, prompt).getResponse();
        }
        if (intent === 'SelectFollowupIntent') {
            if (attributes.conversationState !== STATES.AWAITING_FOLLOWUP_SELECTION || !attributes.followupChoices?.length) {
                return speakText(handlerInput, 'First ask to cancel, move, or complete a check-in.').getResponse();
            }
            const choice = Number(getSlotValue(handlerInput, 'choice'));
            const id = attributes.followupChoices[choice - 1];
            if (!id) return clarification(handlerInput,
                (await listFollowups({ ownerId: userOwnerId, memberName })).followups,
                attributes.pendingAction, { memberName, pendingTime: attributes.pendingTime, pendingStatus: attributes.pendingStatus });
            const followup = await getFollowupById({ ownerId: userOwnerId, memberName, followupId: id });
            if (!followup || followup.status !== 'pending') return speakText(handlerInput, 'That check-in changed. Please list your check-ins again.').getResponse();
            return finishFollowupAction(handlerInput, followup, attributes.pendingAction,
                attributes.pendingTime, attributes.pendingStatus);
        }
        const action = intent === 'CancelFollowupIntent' ? 'cancel' : 'reschedule';
        const dueTime = getSlotValue(handlerInput, 'followupTime');
        if (dueTime && !validTime(dueTime)) return elicitSlot(handlerInput, 'followupTime', COPY.followupTimeNeeded);
        const followup = await selectedFollowup(handlerInput, action, memberName, { pendingTime: dueTime });
        if (!followup) return speakText(handlerInput, COPY.followupNone).getResponse();
        if (!followup.followupId) return followup;
        return finishFollowupAction(handlerInput, followup, action, dueTime);
    }
};

const CorrectReportIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CorrectReportIntent';
    },
    async handle(handlerInput) {
        const attributes = sessionAttributes(handlerInput);
        if (!attributes.lastReportSk) return speakText(handlerInput, COPY.correctionUnavailable).getResponse();
        const memberName = getSlotValue(handlerInput, 'memberName') || attributes.lastReportMember;
        if (memberName !== attributes.lastReportMember
            && attributes.conversationState !== STATES.AWAITING_FOLLOWUP_CONFIRMATION) {
            return speakText(handlerInput, COPY.correctionMember).getResponse();
        }
        const sleepHours = getSlotValue(handlerInput, 'sleepHours');
        const signal = getSlotValue(handlerInput, 'wellnessSignal') || undefined;
        const state = getSlotValue(handlerInput, 'intensity') || undefined;
        if (!sleepHours && !signal && !state && memberName === attributes.lastReportMember) {
            return speakText(handlerInput, 'What should I correct in that report?').getResponse();
        }
        if (sleepHours && (!Number.isFinite(Number(sleepHours)) || Number(sleepHours) < 0 || Number(sleepHours) > 24)) {
            return elicitSlot(handlerInput, 'sleepHours', 'How many hours, from zero to twenty-four?');
        }
        const corrected = await correctWellnessEvent({ ownerId: ownerId(handlerInput),
            memberName: attributes.lastReportMember, correctedMemberName: memberName, eventSk: attributes.lastReportSk,
            signal, state, ...(sleepHours ? { numericValue: Number(sleepHours) } : {}) });
        saveConversationState(handlerInput, { conversationState: null, lastReportSk: corrected.sk,
            lastReportMember: memberName, lastReportSignal: corrected.signal });
        return speakText(handlerInput, COPY.correctionSaved).getResponse();
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
        const discreetMode = getSlotValue(handlerInput, 'discreetMode').toLowerCase() || undefined;
        if (!summaryLength && !preferredFollowupTime && !followupOffers && !discreetMode) {
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
        if (discreetMode && !['on', 'off'].includes(discreetMode)) {
            return speakText(handlerInput, 'Say turn discreet mode on or off.').getResponse();
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
            followupOffers,
            discreetMode
        });
        const changes = [];
        if (summaryLength) changes.push(`${summaryLength} summaries`);
        if (preferredFollowupTime) changes.push(COPY.preferenceTime(preferredFollowupTime));
        if (followupOffers) changes.push(`follow-up suggestions ${followupOffers}`);
        if (discreetMode) changes.push(`discreet mode ${discreetMode}`);
        return speakText(handlerInput, COPY.preferenceSaved(changes)).getResponse();
    }
};

const LinkBeeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'LinkBeeIntent';
    },
    handle(handlerInput) {
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_BEE_CONSENT,
            memberName: defaultMemberName()
        });
        const prompt = COPY.beeConsentQuestion(consentDays());
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, 'Do you authorize CarePulse to use your Bee data?').getResponse();
    }
};

const UnlinkBeeIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'UnlinkBeeIntent';
    },
    handle(handlerInput) {
        saveConversationState(handlerInput, {
            conversationState: STATES.AWAITING_BEE_UNLINK_CONFIRMATION,
            memberName: defaultMemberName()
        });
        speakText(handlerInput, COPY.beeUnlinkQuestion);
        return repromptText(handlerInput, COPY.beeUnlinkQuestion).getResponse();
    }
};

const YesIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
    },
    async handle(handlerInput) {
        const attributes = sessionAttributes(handlerInput);
        if (attributes.conversationState === STATES.AWAITING_BEE_CONSENT) {
            const { linkCode } = await grantBeeConsent({ ownerId: ownerId(handlerInput), memberName: attributes.memberName });
            saveConversationState(handlerInput, { conversationState: null });
            return speakText(handlerInput, COPY.beeConsentSaved)
                .withSimpleCard(CARD_TITLES.beeLink, CARD_CONTENT.beeLink(linkCode, consentDays()))
                .getResponse();
        }
        if (attributes.conversationState === STATES.AWAITING_BEE_UNLINK_CONFIRMATION) {
            const { revoked, eventsDeleted } = await revokeBeeConsent({ ownerId: ownerId(handlerInput), memberName: attributes.memberName });
            saveConversationState(handlerInput, { conversationState: null });
            const speech = revoked || eventsDeleted ? COPY.beeUnlinked(eventsDeleted) : COPY.beeNothingToRemove;
            return speakText(handlerInput, speech).getResponse();
        }
        if (attributes.conversationState === STATES.AWAITING_FOLLOWUP_CONFIRMATION) {
            const followup = await ensureFollowup(handlerInput, {
                memberName: attributes.memberName,
                signal: attributes.signal
            });
            const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName: attributes.memberName });
            const destination = await resolveCaregiver({ ownerId: ownerId(handlerInput),
                memberName: attributes.memberName, caregiverName: context.caregiverName });
            const channel = notificationChannel(destination);
            saveConversationState(handlerInput, {
                conversationState: STATES.AWAITING_CONSENT_CONFIRMATION,
                caregiverName: context.caregiverName,
                followupId: followup.followupId,
                notificationChannel: channel
            });
            const prompt = COPY.scheduleAndConsent(followup.dueTime, context.caregiverName, attributes.signal, followup.dueDate,
                scheduleText(handlerInput, followup, context.timezone), channel);
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
            saveConversationState(handlerInput, { conversationState: null });
            const context = await getCareContext({ ownerId: ownerId(handlerInput), memberName: attributes.memberName });
            return speakText(handlerInput, COPY.consentSaved(attributes.caregiverName))
                .withSimpleCard(CARD_TITLES.permission, context.discreetMode === 'on' ? CARD_CONTENT.discreet
                    : CARD_CONTENT.permission(attributes.caregiverName, attributes.signal))
                .getResponse();
        }
        if ([STATES.AWAITING_FOLLOWUP_SELECTION, STATES.AWAITING_RESCHEDULE_TIME].includes(attributes.conversationState)) {
            const prompt = pendingPrompt(handlerInput);
            return repromptText(handlerInput, prompt).speak(`<speak>${escapeSsml(prompt)}</speak>`).getResponse();
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
    async handle(handlerInput) {
        const state = sessionAttributes(handlerInput).conversationState;
        if (state === STATES.AWAITING_BEE_CONSENT || state === STATES.AWAITING_BEE_UNLINK_CONFIRMATION) {
            saveConversationState(handlerInput, { conversationState: null });
            return speakText(handlerInput, state === STATES.AWAITING_BEE_CONSENT ? COPY.beeConsentDeclined : COPY.beeUnlinkCancelled).getResponse();
        }
        if (state === STATES.AWAITING_FOLLOWUP_CONFIRMATION) {
            saveConversationState(handlerInput, { conversationState: null });
            return speakText(handlerInput, COPY.followupDeclined).getResponse();
        }
        if (state === STATES.AWAITING_CONSENT_CONFIRMATION) {
            const attributes = sessionAttributes(handlerInput);
            const result = await revokeConsent({ ownerId: ownerId(handlerInput), memberName: attributes.memberName, followupId: attributes.followupId });
            saveConversationState(handlerInput, { conversationState: null });
            if (result.mayHaveBeenSent) return speakText(handlerInput,
                'I withdrew that permission. An alert already being sent or accepted cannot be recalled.').getResponse();
            return speakText(handlerInput, COPY.consentDeclined).getResponse();
        }
        if ([STATES.AWAITING_FOLLOWUP_SELECTION, STATES.AWAITING_RESCHEDULE_TIME].includes(state)) {
            saveConversationState(handlerInput, { conversationState: null, followupId: null, followupChoices: null });
            return speakText(handlerInput, 'Okay. I did not change any check-ins.').getResponse();
        }
        return speakText(handlerInput, COPY.okay).getResponse();
    }
};

const SharingIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && ['RevokeSharingIntent', 'ExplainSharingIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
    },
    async handle(handlerInput) {
        if (Alexa.getIntentName(handlerInput.requestEnvelope) === 'ExplainSharingIntent') {
            const prompt = 'With your permission, the alert includes your name and the signal from this follow-up, and asks your caregiver to check in. It does not include your history or Bee transcripts. Permission expires within 36 hours. Say stop sharing my reports to withdraw it. It cannot recall an alert already being sent.';
            return speakText(handlerInput, prompt).getResponse();
        }
        const attributes = sessionAttributes(handlerInput);
        const result = await revokeMemberSharing({ ownerId: ownerId(handlerInput), memberName: attributes.memberName || defaultMemberName() });
        saveConversationState(handlerInput, { conversationState: null });
        return speakText(handlerInput, 'I withdrew the sharing permissions for your existing follow-ups. Your reports stay saved.'
            + (result.mayHaveBeenSent ? ' An alert already being sent or accepted cannot be recalled.' : '')).getResponse();
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

function pendingPrompt(handlerInput) {
    const attributes = sessionAttributes(handlerInput);
    switch (attributes.conversationState) {
        case STATES.AWAITING_FOLLOWUP_CONFIRMATION:
            return COPY.followupReprompt(attributes.followupTime || '18:00');
        case STATES.AWAITING_CONSENT_CONFIRMATION:
            return COPY.consentQuestion(attributes.caregiverName, attributes.signal, attributes.notificationChannel);
        case STATES.AWAITING_FOLLOWUP_STATUS:
            return COPY.missingStatus;
        case STATES.AWAITING_FOLLOWUP_SELECTION:
            return 'Say the number of the check-in, for example one or two.';
        case STATES.AWAITING_RESCHEDULE_TIME:
            return COPY.followupTimeNeeded;
        case STATES.AWAITING_BEE_CONSENT:
            return COPY.beeConsentQuestion(consentDays());
        case STATES.AWAITING_BEE_UNLINK_CONFIRMATION:
            return COPY.beeUnlinkQuestion;
        default:
            return null;
    }
}

const RepeatIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.RepeatIntent';
    },
    handle(handlerInput) {
        const prompt = pendingPrompt(handlerInput) || COPY.help;
        return repromptText(handlerInput, prompt).speak(`<speak>${escapeSsml(prompt)}</speak>`).getResponse();
    }
};

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const prompt = pendingPrompt(handlerInput) || COPY.help;
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, prompt).getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
    },
    handle(handlerInput) {
        saveConversationState(handlerInput, { conversationState: null, followupId: null, followupChoices: null });
        return speakText(handlerInput, COPY.goodbye).getResponse();
    }
};

const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const count = (sessionAttributes(handlerInput).fallbackCount || 0) + 1;
        saveConversationState(handlerInput, { fallbackCount: count });
        const prompt = count > 1 ? COPY.fallback : pendingPrompt(handlerInput) || COPY.fallback;
        speakText(handlerInput, prompt);
        return repromptText(handlerInput, prompt).getResponse();
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
        metric('RequestErrors');
        speakText(handlerInput, handlerInput.attributesManager.getRequestAttributes().reportSaved ? COPY.reportSavedError : COPY.error);
        return repromptText(handlerInput, COPY.error).getResponse();
    }
};

const skill = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        ReportWellnessIntentHandler,
        ScheduleFollowupIntentHandler,
        ConfigureCaregiverAlertIntentHandler,
        CompleteFollowupIntentHandler,
        ManageFollowupIntentHandler,
        CorrectReportIntentHandler,
        GetWellnessSummaryIntentHandler,
        SetCarePreferencesIntentHandler,
        LinkBeeIntentHandler,
        UnlinkBeeIntentHandler,
        YesIntentHandler,
        NoIntentHandler,
        SharingIntentHandler,
        EmergencyGuidanceIntentHandler,
        HelpIntentHandler,
        RepeatIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        SessionEndedRequestHandler
    )
    .addErrorHandlers(CatchAllExceptionHandler);

if (process.env.CAREPULSE_ALEXA_SKILL_ID) skill.withSkillId(process.env.CAREPULSE_ALEXA_SKILL_ID);
exports.handler = skill.lambda();

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

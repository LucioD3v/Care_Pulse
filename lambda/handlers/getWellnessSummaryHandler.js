'use strict';

const Alexa = require('ask-sdk-core');
const { getWellnessSnapshot, getWellnessHistory, getCareContext, getPendingFollowup, getCareDashboard } = require('../care_service');
const { signalsFromHistory, isBeeEvent } = require('../apl/wellnessSnapshotPayload');
const { supportsDashboard, addCareDashboard } = require('../care_dashboard');
const { CARD_TITLES, CARD_CONTENT, COPY } = require('../voice_copy');
const { spokenTime } = require('../voice_format');

function buildSummaryLine(snapshot, signalText) {
    const status = snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1);
    return `${status} · ${snapshot.eventCount} reports across ${snapshot.observedDays} days covering ${signalText}`;
}

function createGetWellnessSummaryHandler({ getSlotValue, ownerId, defaultMemberName, speakText }) {
    // Request-type-independent summary runner. It does NOT call getIntentName, so it can
    // be driven from a voice IntentRequest or an APL UserEvent (welcome menu button).
    // `detailed` is computed by the caller and passed in explicitly.
    async function runSummary(handlerInput, { detailed = false } = {}) {
        const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
        const timeframe = getSlotValue(handlerInput, 'timeframe') || 'this week';
        const userOwnerId = ownerId(handlerInput);
        const now = new Date();
        const context = await getCareContext({ ownerId: userOwnerId, memberName });
        const [history, pending] = await Promise.all([
            getWellnessHistory({ ownerId: userOwnerId, memberName, timeframe, context, now }),
            getPendingFollowup({ ownerId: userOwnerId, memberName })
        ]);
        const snapshot = await getWellnessSnapshot({
            ownerId: userOwnerId, memberName, timeframe, context, now, history, pending
        });
        const signalText = snapshot.signals.length ? snapshot.signals.join(', ') : 'no recent signals';
        const beeEventCount = context.discreetMode === 'on' ? 0 : history.filter(isBeeEvent).length;
        const isDetailed = context.summaryLength === 'detailed' || detailed;
        const summary = isDetailed
            ? COPY.summaryDetailed(memberName, timeframe, snapshot, signalText)
            : COPY.summaryShort(memberName, timeframe, snapshot);
        const speech = beeEventCount ? `${summary} ${COPY.beeSourceNote(beeEventCount)}` : summary;

        const responseBuilder = speakText(handlerInput, speech)
            .withSimpleCard(CARD_TITLES.summary, context.discreetMode === 'on' ? CARD_CONTENT.discreet
                : CARD_CONTENT.summary(memberName, timeframe, snapshot, signalText));
        if (supportsDashboard(handlerInput)) {
            const dashboard = await getCareDashboard({
                ownerId: userOwnerId, memberName, context, history, followup: pending, now
            });
            addCareDashboard(handlerInput, context.discreetMode === 'on'
                ? { lastReport: 'Private', nextFollowup: pending ? 'Check-in pending' : 'None scheduled',
                    permission: 'Ask CarePulse for details' } : dashboard, {
                memberName: context.discreetMode === 'on' ? 'CarePulse' : memberName,
                timeframe,
                summaryLine: context.discreetMode === 'on' ? 'CarePulse wellness information is private'
                    : buildSummaryLine(snapshot, signalText),
                followupScheduled: context.discreetMode !== 'on' && Boolean(pending),
                followupTime: context.discreetMode !== 'on' && pending ? `${pending.dueDate} at ${spokenTime(pending.dueTime)}` : '',
                caregiverAlerted: false,
                hasBeeData: beeEventCount > 0,
                signals: context.discreetMode === 'on' ? {} : signalsFromHistory(history)
            });
        }
        return responseBuilder.getResponse();
    }

    const handler = {
        canHandle(handlerInput) {
            return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
                && ['GetWellnessSummaryIntent', 'GetWellnessDetailsIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
        },
        handle(handlerInput) {
            const detailed = Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetWellnessDetailsIntent';
            return runSummary(handlerInput, { detailed });
        },
        runSummary
    };

    return handler;
}

module.exports = { createGetWellnessSummaryHandler, buildSummaryLine };

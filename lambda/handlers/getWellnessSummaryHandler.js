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
    return {
        canHandle(handlerInput) {
            return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
                && ['GetWellnessSummaryIntent', 'GetWellnessDetailsIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
        },
        async handle(handlerInput) {
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
            const speech = context.summaryLength === 'detailed'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetWellnessDetailsIntent'
                ? COPY.summaryDetailed(memberName, timeframe, snapshot, signalText)
                : COPY.summaryShort(memberName, timeframe, snapshot);

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
                    hasBeeData: context.discreetMode !== 'on' && history.some(isBeeEvent),
                    signals: context.discreetMode === 'on' ? {} : signalsFromHistory(history)
                });
            }
            return responseBuilder.getResponse();
        }
    };
}

module.exports = { createGetWellnessSummaryHandler, buildSummaryLine };

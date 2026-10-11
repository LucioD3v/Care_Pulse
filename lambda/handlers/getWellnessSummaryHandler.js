'use strict';

const Alexa = require('ask-sdk-core');
const { getWellnessSnapshot, getWellnessHistory, getCareContext, getPendingFollowup } = require('../care_service');
const { wellnessSnapshotDirective, signalsFromHistory, isBeeEvent } = require('../apl/wellnessSnapshotPayload');
const { addAPLIfSupported } = require('../apl/aplSupport');
const { CARD_TITLES, CARD_CONTENT, COPY } = require('../voice_copy');
const { spokenTime } = require('../voice_format');

function buildSummaryLine(snapshot, signalText) {
    const status = snapshot.status.charAt(0).toUpperCase() + snapshot.status.slice(1);
    return `${status} · ${snapshot.eventCount} reports covering ${signalText}`;
}

function createGetWellnessSummaryHandler({ getSlotValue, ownerId, defaultMemberName, speakText }) {
    return {
        canHandle(handlerInput) {
            return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
                && Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetWellnessSummaryIntent';
        },
        async handle(handlerInput) {
            const memberName = getSlotValue(handlerInput, 'memberName') || defaultMemberName();
            const timeframe = getSlotValue(handlerInput, 'timeframe') || 'this week';
            const userOwnerId = ownerId(handlerInput);
            const [snapshot, history, context, pending] = await Promise.all([
                getWellnessSnapshot({ ownerId: userOwnerId, memberName, timeframe }),
                getWellnessHistory({ ownerId: userOwnerId, memberName, timeframe, limit: 50 }),
                getCareContext({ ownerId: userOwnerId, memberName }),
                getPendingFollowup({ ownerId: userOwnerId, memberName })
            ]);
            const signalText = snapshot.signals.length ? snapshot.signals.join(', ') : 'no recent signals';
            const speech = context.summaryLength === 'detailed'
                ? COPY.summaryDetailed(memberName, timeframe, snapshot, signalText)
                : COPY.summaryShort(memberName, timeframe, snapshot);

            const directive = wellnessSnapshotDirective({
                memberName,
                timeframe,
                summaryLine: buildSummaryLine(snapshot, signalText),
                followupScheduled: Boolean(pending),
                followupTime: pending ? `${pending.dueDate} at ${spokenTime(pending.dueTime)}` : '',
                caregiverAlerted: false,
                hasBeeData: history.some(isBeeEvent),
                signals: signalsFromHistory(history)
            });

            const responseBuilder = speakText(handlerInput, speech)
                .withSimpleCard(CARD_TITLES.summary, CARD_CONTENT.summary(memberName, timeframe, snapshot, signalText));
            addAPLIfSupported(handlerInput, directive, responseBuilder);
            return responseBuilder.getResponse();
        }
    };
}

module.exports = { createGetWellnessSummaryHandler, buildSummaryLine };

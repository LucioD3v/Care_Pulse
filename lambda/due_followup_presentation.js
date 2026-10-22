'use strict';

const document = require('./apl/dueFollowup.json');
const { supportsAPL } = require('./apl/aplSupport');
const { escapeSsml } = require('./voice_format');
const { imageUrls } = require('./welcome_presentation');
const { backgroundImageUrl } = require('./report_wellness_presentation');

const DOCUMENT_TOKEN = 'carepulse-due-followup';
const CARD_TITLE = 'CarePulse follow-up';

function dueFollowupDirective(displayText) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            followupData: {
                coverImageUrl: imageUrls().cover,
                backgroundImageUrl: backgroundImageUrl(),
                question: escapeSsml(displayText)
            }
        }
    };
}

// `displayText` is the text shown on screen and in the app card. It is decoupled from
// the spoken prompt so discreet mode can redact the screen/card while speech stays
// personalized. When omitted it falls back to the spoken `question`.
function addDueFollowupPresentation(handlerInput, responseBuilder, question, displayText = question) {
    const images = imageUrls();
    if (supportsAPL(handlerInput) && images.cover && backgroundImageUrl()) {
        responseBuilder.addDirective(dueFollowupDirective(displayText));
    }
    if (images.small && images.large) {
        responseBuilder.withStandardCard(CARD_TITLE, displayText, images.small, images.large);
    } else {
        responseBuilder.withSimpleCard(CARD_TITLE, displayText);
    }
    return responseBuilder;
}

module.exports = { DOCUMENT_TOKEN, dueFollowupDirective, addDueFollowupPresentation };

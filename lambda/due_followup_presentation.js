'use strict';

const document = require('./apl/dueFollowup.json');
const { supportsAPL } = require('./apl/aplSupport');
const { escapeSsml } = require('./voice_format');
const { imageUrls } = require('./welcome_presentation');
const { backgroundImageUrl } = require('./report_wellness_presentation');

const DOCUMENT_TOKEN = 'carepulse-due-followup';
const CARD_TITLE = 'CarePulse follow-up';

function dueFollowupDirective(question) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            followupData: {
                coverImageUrl: imageUrls().cover,
                backgroundImageUrl: backgroundImageUrl(),
                question: escapeSsml(question)
            }
        }
    };
}

function addDueFollowupPresentation(handlerInput, responseBuilder, question) {
    const images = imageUrls();
    if (supportsAPL(handlerInput) && images.cover && backgroundImageUrl()) {
        responseBuilder.addDirective(dueFollowupDirective(question));
    }
    if (images.small && images.large) {
        responseBuilder.withStandardCard(CARD_TITLE, question, images.small, images.large);
    } else {
        responseBuilder.withSimpleCard(CARD_TITLE, question);
    }
    return responseBuilder;
}

module.exports = { DOCUMENT_TOKEN, dueFollowupDirective, addDueFollowupPresentation };

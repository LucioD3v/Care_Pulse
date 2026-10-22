'use strict';

const document = require('./apl/welcomeCover.json');
const { supportsAPL } = require('./apl/aplSupport');

const CARD_TITLE = 'CarePulse';
const CARD_TEXT = 'Share how you feel, review a wellness summary, or manage a follow-up.';
const DOCUMENT_TOKEN = 'carepulse-welcome-menu';

function httpsUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function imageUrls() {
    const cover = httpsUrl(process.env.CAREPULSE_COVER_IMAGE_URL);
    return {
        cover: cover || httpsUrl(process.env.CAREPULSE_CARD_LARGE_IMAGE_URL),
        background: httpsUrl(process.env.CAREPULSE_HOME_BACKGROUND_URL)
            || httpsUrl(process.env.CAREPULSE_REPORT_BACKGROUND_URL)
            || httpsUrl(process.env.CAREPULSE_WELLNESS_BACKGROUND_URL)
            || cover,
        small: httpsUrl(process.env.CAREPULSE_CARD_SMALL_IMAGE_URL) || cover,
        large: httpsUrl(process.env.CAREPULSE_CARD_LARGE_IMAGE_URL) || cover
    };
}

function welcomeCoverDirective(imageUrl, backgroundImageUrl = imageUrl) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            coverData: { imageUrl, backgroundImageUrl }
        }
    };
}

function addWelcomePresentation(handlerInput, responseBuilder) {
    const images = imageUrls();
    if (supportsAPL(handlerInput) && images.cover) {
        responseBuilder.addDirective(welcomeCoverDirective(images.cover, images.background));
    }
    if (images.small && images.large) {
        responseBuilder.withStandardCard(CARD_TITLE, CARD_TEXT, images.small, images.large);
    } else {
        responseBuilder.withSimpleCard(CARD_TITLE, CARD_TEXT);
    }
    return responseBuilder;
}

module.exports = { DOCUMENT_TOKEN, addWelcomePresentation, welcomeCoverDirective, imageUrls };

'use strict';

const document = require('./apl/welcomeCover.json');
const { supportsAPL } = require('./apl/aplSupport');

const CARD_TITLE = 'CarePulse';
const CARD_TEXT = 'Share how you feel, review a wellness summary, or manage a follow-up.';

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
        small: httpsUrl(process.env.CAREPULSE_CARD_SMALL_IMAGE_URL) || cover,
        large: httpsUrl(process.env.CAREPULSE_CARD_LARGE_IMAGE_URL) || cover
    };
}

function welcomeCoverDirective(imageUrl) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: 'carepulse-welcome-cover',
        document,
        datasources: {
            coverData: { imageUrl }
        }
    };
}

function addWelcomePresentation(handlerInput, responseBuilder) {
    const images = imageUrls();
    if (supportsAPL(handlerInput) && images.cover) {
        responseBuilder.addDirective(welcomeCoverDirective(images.cover));
    }
    if (images.small && images.large) {
        responseBuilder.withStandardCard(CARD_TITLE, CARD_TEXT, images.small, images.large);
    } else {
        responseBuilder.withSimpleCard(CARD_TITLE, CARD_TEXT);
    }
    return responseBuilder;
}

module.exports = { addWelcomePresentation, welcomeCoverDirective, imageUrls };

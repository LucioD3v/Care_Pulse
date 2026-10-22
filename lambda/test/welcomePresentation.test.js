'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { DOCUMENT_TOKEN, addWelcomePresentation } = require('../welcome_presentation');

afterEach(() => {
    delete process.env.CAREPULSE_COVER_IMAGE_URL;
    delete process.env.CAREPULSE_CARD_SMALL_IMAGE_URL;
    delete process.env.CAREPULSE_CARD_LARGE_IMAGE_URL;
    delete process.env.CAREPULSE_HOME_BACKGROUND_URL;
    delete process.env.CAREPULSE_REPORT_BACKGROUND_URL;
    delete process.env.CAREPULSE_WELLNESS_BACKGROUND_URL;
});

function input(screen = false) {
    return {
        requestEnvelope: {
            context: {
                System: {
                    device: {
                        supportedInterfaces: screen ? { 'Alexa.Presentation.APL': {} } : {}
                    }
                }
            }
        }
    };
}

function builder() {
    return {
        directives: [],
        card: null,
        addDirective(value) { this.directives.push(value); return this; },
        withStandardCard(title, content, smallImageUrl, largeImageUrl) {
            this.card = { type: 'Standard', title, content, smallImageUrl, largeImageUrl };
            return this;
        },
        withSimpleCard(title, content) { this.card = { type: 'Simple', title, content }; return this; }
    };
}

test('welcome presentation adds responsive APL and phone card images', () => {
    process.env.CAREPULSE_COVER_IMAGE_URL = 'https://assets.example.test/carepulse-cover-apl.png';
    process.env.CAREPULSE_CARD_SMALL_IMAGE_URL = 'https://assets.example.test/carepulse-cover-card-small.png';
    process.env.CAREPULSE_CARD_LARGE_IMAGE_URL = 'https://assets.example.test/carepulse-cover-card-large.png';
    process.env.CAREPULSE_HOME_BACKGROUND_URL = 'https://assets.example.test/carepulse-home-background.png';
    const response = builder();

    addWelcomePresentation(input(true), response);

    assert.equal(response.directives[0].type, 'Alexa.Presentation.APL.RenderDocument');
    assert.equal(response.directives[0].token, DOCUMENT_TOKEN);
    assert.equal(response.directives[0].datasources.coverData.imageUrl,
        'https://assets.example.test/carepulse-cover-apl.png');
    assert.equal(response.directives[0].datasources.coverData.backgroundImageUrl,
        'https://assets.example.test/carepulse-home-background.png');
    const pager = response.directives[0].document.mainTemplate.items[0];
    assert.equal(pager.type, 'Pager');
    assert.equal(pager.items.length, 2);
    assert.deepEqual(pager.onMount[0], {
        type: 'AutoPage', componentId: 'welcomeMenuPager', count: 1, delay: 5000, duration: 0, screenLock: true
    });
    const menu = JSON.stringify(pager.items[1]);
    for (const action of ['report', 'summary', 'schedule']) {
        assert.match(menu, new RegExp(`welcome-action.*${action}`));
    }
    assert.deepEqual(response.card, {
        type: 'Standard',
        title: 'CarePulse',
        content: 'Share how you feel, review a wellness summary, or manage a follow-up.',
        smallImageUrl: 'https://assets.example.test/carepulse-cover-card-small.png',
        largeImageUrl: 'https://assets.example.test/carepulse-cover-card-large.png'
    });
});

test('voice-only launch keeps the phone card and rejects non-HTTPS images', () => {
    process.env.CAREPULSE_COVER_IMAGE_URL = 'http://insecure.example.test/cover.png';
    delete process.env.CAREPULSE_CARD_SMALL_IMAGE_URL;
    delete process.env.CAREPULSE_CARD_LARGE_IMAGE_URL;
    const response = builder();

    addWelcomePresentation(input(false), response);

    assert.equal(response.directives.length, 0);
    assert.equal(response.card.type, 'Simple');
});

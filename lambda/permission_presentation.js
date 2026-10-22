'use strict';

const document = require('./apl/permissionConfirmation.json');
const { supportsAPL } = require('./apl/aplSupport');
const { escapeSsml } = require('./voice_format');
const { backgroundImageUrl: reportBackgroundImageUrl } = require('./report_wellness_presentation');

const DOCUMENT_TOKEN = 'carepulse-permission-confirmation';

function httpsUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function backgroundImageUrl() {
    return httpsUrl(process.env.CAREPULSE_PERMISSION_BACKGROUND_URL)
        || reportBackgroundImageUrl();
}

function permissionDirective(options = {}) {
    const discreet = options.discreetMode === 'on';
    const caregiverName = String(options.caregiverName || 'your caregiver');
    const signal = String(options.signal || 'the wellness signal').replace(/-/g, ' ');
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            permissionData: {
                backgroundImageUrl: backgroundImageUrl(),
                message: escapeSsml(discreet
                    ? 'Your permission applies only to this follow-up.'
                    : `Only this follow-up may be shared with ${caregiverName}.`),
                showDetails: !discreet,
                caregiverName: discreet ? '' : escapeSsml(caregiverName),
                condition: discreet ? '' : escapeSsml(`${signal} repeats`)
            }
        }
    };
}

function addPermissionPresentation(handlerInput, responseBuilder, options) {
    if (supportsAPL(handlerInput) && backgroundImageUrl()) {
        responseBuilder.addDirective(permissionDirective(options));
    }
    return responseBuilder;
}

module.exports = {
    DOCUMENT_TOKEN,
    backgroundImageUrl,
    permissionDirective,
    addPermissionPresentation
};

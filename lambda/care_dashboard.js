'use strict';

const Alexa = require('ask-sdk-core');
const document = require('./apl/care_dashboard.json');
const { escapeSsml } = require('./voice_format');

function supportsDashboard(handlerInput) {
    return Boolean(Alexa.getSupportedInterfaces(handlerInput.requestEnvelope)?.['Alexa.Presentation.APL']);
}

function addCareDashboard(handlerInput, dashboard) {
    if (!supportsDashboard(handlerInput)) {
        return handlerInput.responseBuilder;
    }
    return handlerInput.responseBuilder.addDirective({
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: 'carepulse-dashboard',
        document,
        datasources: {
            careData: {
                lastReport: escapeSsml(dashboard.lastReport),
                nextFollowup: escapeSsml(dashboard.nextFollowup),
                permission: escapeSsml(dashboard.permission)
            }
        }
    });
}

module.exports = { supportsDashboard, addCareDashboard };

'use strict';

const document = require('./apl/care_dashboard.json');
const { escapeSsml } = require('./voice_format');
const { supportsAPL, addAPLIfSupported } = require('./apl/aplSupport');
const { wellnessSnapshotDirective } = require('./apl/wellnessSnapshotPayload');

function supportsDashboard(handlerInput) {
    return supportsAPL(handlerInput);
}

function addCareDashboard(handlerInput, dashboard, snapshotOptions) {
    if (!supportsDashboard(handlerInput)) {
        return handlerInput.responseBuilder;
    }
    if (snapshotOptions) {
        return addAPLIfSupported(handlerInput,
            wellnessSnapshotDirective({ ...snapshotOptions, dashboard }), handlerInput.responseBuilder);
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

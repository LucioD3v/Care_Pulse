'use strict';

const document = require('./apl/reportWellness.json');
const { supportsAPL } = require('./apl/aplSupport');
const { escapeSsml, spokenTime } = require('./voice_format');

const DOCUMENT_TOKEN = 'carepulse-report-wellness';
const EVENING_OPTIONS = ['19:00', '20:00', '18:00'];

function httpsUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function suggestedFollowupTimes(preferredTime = '18:00') {
    return [...new Set([preferredTime, ...EVENING_OPTIONS])]
        .filter(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
        .slice(0, 3);
}

function backgroundImageUrl() {
    return httpsUrl(process.env.CAREPULSE_REPORT_BACKGROUND_URL)
        || httpsUrl(process.env.CAREPULSE_WELLNESS_BACKGROUND_URL);
}

function reportWellnessDirective(options = {}) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            reportData: {
                backgroundImageUrl: backgroundImageUrl(),
                headline: escapeSsml(options.headline || 'Your wellness report is saved'),
                summary: escapeSsml(options.summary || 'Thank you for checking in.'),
                showFollowupOptions: options.showFollowupOptions !== false,
                options: (options.options || []).slice(0, 3).map(option => ({
                    time: option.time,
                    label: spokenTime(option.time),
                    dayLabel: escapeSsml(option.dayLabel || '')
                }))
            }
        }
    };
}

function addReportWellnessPresentation(handlerInput, responseBuilder, options) {
    if (supportsAPL(handlerInput) && backgroundImageUrl()) {
        responseBuilder.addDirective(reportWellnessDirective(options));
    }
    return responseBuilder;
}

module.exports = {
    DOCUMENT_TOKEN,
    suggestedFollowupTimes,
    backgroundImageUrl,
    reportWellnessDirective,
    addReportWellnessPresentation
};

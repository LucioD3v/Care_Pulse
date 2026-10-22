'use strict';

const document = require('./apl/followupCompletion.json');
const { supportsAPL } = require('./apl/aplSupport');
const { escapeSsml } = require('./voice_format');
const { backgroundImageUrl: reportBackgroundImageUrl } = require('./report_wellness_presentation');

const DOCUMENT_TOKEN = 'carepulse-followup-completion';

function httpsUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

function backgroundImageUrl() {
    return httpsUrl(process.env.CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL)
        || reportBackgroundImageUrl();
}

function statusTheme(status) {
    if (status === 'worse') {
        return { backgroundColor: 'rgba(111, 43, 73, 0.72)', borderColor: '#F0B8C0', accentColor: '#FFD6DC' };
    }
    if (status === 'same') {
        return { backgroundColor: 'rgba(74, 61, 122, 0.68)', borderColor: '#CEB8F6', accentColor: '#E1D5FF' };
    }
    return { backgroundColor: 'rgba(22, 91, 89, 0.68)', borderColor: '#93DDCF', accentColor: '#C9F8E9' };
}

function statusLabel(status) {
    return { better: 'Feeling better', same: 'Feeling the same', worse: 'Feeling worse' }[status] || 'Response recorded';
}

function followupCompletionDirective(options = {}) {
    const discreet = options.discreetMode === 'on';
    const theme = statusTheme(options.status);
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: {
            completionData: {
                backgroundImageUrl: backgroundImageUrl(),
                message: escapeSsml(discreet ? 'Thank you. Your check-in is saved.'
                    : `Thank you, ${options.memberName || 'there'}. Your response is saved.`),
                showDetails: !discreet,
                statusLabel: discreet ? '' : statusLabel(options.status),
                alertStatus: discreet ? '' : escapeSsml(options.alertStatus || 'No alert needed'),
                statusBackgroundColor: theme.backgroundColor,
                statusBorderColor: theme.borderColor,
                statusAccentColor: theme.accentColor
            }
        }
    };
}

function addFollowupCompletionPresentation(handlerInput, responseBuilder, options) {
    if (supportsAPL(handlerInput) && backgroundImageUrl()) {
        responseBuilder.addDirective(followupCompletionDirective(options));
    }
    return responseBuilder;
}

module.exports = {
    DOCUMENT_TOKEN,
    backgroundImageUrl,
    followupCompletionDirective,
    addFollowupCompletionPresentation
};

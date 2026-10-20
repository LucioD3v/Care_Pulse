'use strict';

const document = require('./wellnessSnapshot.json');
const { escapeSsml } = require('../voice_format');
const { sleepIntensity } = require('../care_baseline');

const DOCUMENT_TOKEN = 'wellnessSnapshot';
const CARD_SIGNALS = ['sleep', 'energy', 'mood', 'appetite'];
const CARD_SLOT_BY_SIGNAL = { sleep: 'sleep', tiredness: 'energy', energy: 'energy', mood: 'mood', appetite: 'appetite' };
const HIGH_STATES = new Set(['high', 'worse', 'severe', 'much-more-than-usual']);
const MODERATE_STATES = new Set(['moderate', 'more-than-usual', 'same']);

function httpsUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'https:' ? parsed.href : '';
    } catch {
        return '';
    }
}

const INTENSITY_STYLE = {
    unknown: { intensityPercent: 0, statusColor: '#A0A0A0' },
    low: { intensityPercent: 20, statusColor: '#1DB954' },
    moderate: { intensityPercent: 55, statusColor: '#F5A623' },
    high: { intensityPercent: 90, statusColor: '#E74C3C' }
};

function buildSignalEntry(signal, rawValue, intensity, source) {
    const style = INTENSITY_STYLE[intensity] || INTENSITY_STYLE.unknown;
    return {
        label: signal,
        value: rawValue || 'No data',
        intensityPercent: style.intensityPercent,
        statusColor: style.statusColor,
        source: source === 'bee' ? 'Bee 🐝' : ''
    };
}

function isBeeEvent(event) {
    return event.provenance === 'bee' || event.source === 'bee';
}

function intensityFromState(state) {
    if (HIGH_STATES.has(state)) return 'high';
    if (MODERATE_STATES.has(state)) return 'moderate';
    return ['low', 'better'].includes(state) ? 'low' : 'unknown';
}

// History arrives newest first, so the first event per card slot is the latest reading.
function signalsFromHistory(history) {
    const signals = {};
    for (const event of history) {
        const slot = CARD_SLOT_BY_SIGNAL[event.signal];
        if (!slot || signals[slot]) continue;
        const value = slot === 'sleep' && Number.isFinite(event.numericValue)
            ? `${event.numericValue} h`
            : String(event.state || '').replace(/-/g, ' ');
        signals[slot] = buildSignalEntry(slot, value, intensityFromState(event.state), isBeeEvent(event) ? 'bee' : 'alexa');
    }
    return signals;
}

function escapedEntry(entry) {
    return { ...entry, label: escapeSsml(entry.label), value: escapeSsml(entry.value) };
}

function buildWellnessSnapshotPayload(opts = {}) {
    const signals = opts.signals || {};
    return {
        backgroundImageUrl: httpsUrl(process.env.CAREPULSE_WELLNESS_BACKGROUND_URL),
        memberName: escapeSsml(opts.memberName || 'Member'),
        timeframe: escapeSsml(opts.timeframe || 'this week'),
        summaryLine: escapeSsml(opts.summaryLine || ''),
        followupScheduled: Boolean(opts.followupScheduled),
        followupTime: escapeSsml(opts.followupTime || ''),
        caregiverAlerted: Boolean(opts.caregiverAlerted),
        hasBeeData: Boolean(opts.hasBeeData),
        dashboard: {
            lastReport: escapeSsml(opts.dashboard?.lastReport || 'No recent report'),
            nextFollowup: escapeSsml(opts.dashboard?.nextFollowup || 'None scheduled'),
            permission: escapeSsml(opts.dashboard?.permission || 'No follow-up awaiting permission')
        },
        signals: Object.fromEntries(CARD_SIGNALS.map(name => [
            name,
            escapedEntry(signals[name] || buildSignalEntry(name, 'No data', 'unknown', ''))
        ]))
    };
}

function wellnessSnapshotDirective(payloadOpts) {
    return {
        type: 'Alexa.Presentation.APL.RenderDocument',
        token: DOCUMENT_TOKEN,
        document,
        datasources: { wellnessData: buildWellnessSnapshotPayload(payloadOpts) }
    };
}

module.exports = {
    buildSignalEntry,
    sleepIntensity,
    signalsFromHistory,
    isBeeEvent,
    buildWellnessSnapshotPayload,
    wellnessSnapshotDirective
};

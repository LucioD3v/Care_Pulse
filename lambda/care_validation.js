'use strict';

const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
const SIGNALS = ['tiredness', 'sleep', 'mood', 'appetite', 'dizziness', 'discomfort'];
const STATES = ['reported', 'unknown', 'more-than-usual', 'less-than-usual', 'a-little', 'about-the-same', 'normal', 'better', 'same', 'worse'];

function validateSignal(value) {
    const signal = normalize(value);
    if (!SIGNALS.includes(signal)) throw new TypeError('Unsupported wellness signal.');
    return signal;
}

function validateReport(signal, state, numericValue) {
    validateSignal(signal);
    if (!STATES.includes(normalize(state))) throw new TypeError('Unsupported wellness state.');
    if (numericValue !== undefined && (normalize(signal) !== 'sleep'
        || typeof numericValue !== 'number' || !Number.isFinite(numericValue) || numericValue < 0 || numericValue > 24)) {
        throw new TypeError('Sleep hours must be a number between zero and twenty-four.');
    }
}

module.exports = { normalize, validateSignal, validateReport, SIGNALS, STATES };

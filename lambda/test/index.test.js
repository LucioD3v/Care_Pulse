'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeVitals, timeframeStart } = require('../index')._test;

test('timeframeStart uses the beginning of the UTC day for today', () => {
    const now = new Date('2026-10-06T18:30:00.000Z');
    assert.equal(timeframeStart('today', now).toISOString(), '2026-10-06T00:00:00.000Z');
});

test('timeframeStart uses seven days for this week', () => {
    const now = new Date('2026-10-06T18:30:00.000Z');
    assert.equal(timeframeStart('this week', now).toISOString(), '2026-09-29T18:30:00.000Z');
});

test('summarizeVitals reports averages without making a diagnosis', () => {
    const summary = summarizeVitals([
        { Metric: 'heart rate', Value: 70, Unit: 'beats per minute' },
        { Metric: 'heart rate', Value: 80, Unit: 'beats per minute' }
    ], 'this week');

    assert.match(summary, /2 readings/);
    assert.match(summary, /average heart rate was 75 beats per minute/);
    assert.match(summary, /not medical advice/);
});

test('summarizeVitals handles an empty history', () => {
    assert.equal(
        summarizeVitals([], 'today'),
        "I couldn't find any health readings for today."
    );
});

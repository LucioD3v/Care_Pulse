'use strict';

function verifiedSleepBaseline(context) {
    const value = context.baselineSleepHours ?? context.sleepHoursBaseline;
    const baseline = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(baseline) && baseline > 0 && baseline <= 24
        && ['member', 'caregiver', 'configuration', 'demo'].includes(context.baselineSource)
        ? baseline : null;
}

// Describes a single reading's distance from a configured routine, not a diagnosis.
function sleepIntensity(hoursSlept, baselineHours) {
    if (!Number.isFinite(hoursSlept) || !Number.isFinite(baselineHours)) return 'unknown';
    const delta = Math.abs(hoursSlept - baselineHours);
    if (delta <= 0.5) return 'low';
    if (delta <= 2) return 'moderate';
    return 'high';
}

module.exports = { verifiedSleepBaseline, sleepIntensity };

'use strict';

const { Temporal } = require('@js-temporal/polyfill');
const RULE_VERSION = '2026-10-09.v1';
const DEFAULT_TIME_ZONE = 'America/Mexico_City';

function periodBounds(timeframe, timezone, now = new Date()) {
    const instant = Temporal.Instant.from(now.toISOString());
    const today = instant.toZonedDateTimeISO(timezone).toPlainDate();
    const days = { today: 1, 'this week': 7, 'this month': 30 }[timeframe];
    if (!days) throw new TypeError('Unsupported history timeframe.');
    const start = today.subtract({ days: days - 1 });
    return {
        timeframe, timezone,
        startDate: start.toString(), endDate: today.toString(),
        start: start.toZonedDateTime(timezone).toInstant().toString({ fractionalSecondDigits: 3 }),
        end: now.toISOString(),
        ruleVersion: RULE_VERSION
    };
}

function localDay(timestamp, timezone) {
    return Temporal.Instant.from(timestamp).toZonedDateTimeISO(timezone).toPlainDate().toString();
}

function followupInstant(dueDate, dueTime, timezone) {
    return Temporal.PlainDateTime.from(dueDate + 'T' + dueTime)
        .toZonedDateTime(timezone, { disambiguation: 'reject' })
        .toInstant().toString({ fractionalSecondDigits: 3 });
}

module.exports = { RULE_VERSION, DEFAULT_TIME_ZONE, periodBounds, localDay, followupInstant };

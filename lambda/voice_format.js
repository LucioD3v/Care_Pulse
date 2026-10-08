'use strict';

function escapeSsml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[character]);
}

function localDateTime(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {});
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`
    };
}

function addOneDay(dateText) {
    const date = new Date(`${dateText}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function spokenTime(timeText) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeText)) {
        return String(timeText);
    }
    const [hours, minutes] = timeText.split(':').map(Number);
    const hour = hours % 12 || 12;
    const minuteText = minutes ? `:${String(minutes).padStart(2, '0')}` : '';
    return `${hour}${minuteText} ${hours < 12 ? 'AM' : 'PM'}`;
}

module.exports = { escapeSsml, localDateTime, addOneDay, spokenTime };

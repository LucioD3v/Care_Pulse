'use strict';

const { spokenTime } = require('./voice_format');

const CARD_TITLES = {
    wellness: 'CarePulse report',
    followup: 'CarePulse follow-up',
    summary: 'CarePulse summary',
    permission: 'CarePulse permission',
    beeLink: 'CarePulse Bee link'
};

const CARD_CONTENT = {
    wellness: (memberName, signal, summary) => `${memberName}: ${signal}\n${summary}`,
    followup: (memberName, status, alertStatus) => `${memberName}\nFollow-up: completed\nStatus: ${status}\nCare Circle: ${alertStatus}`,
    summary: (memberName, timeframe, snapshot, signals) => `${memberName} · ${timeframe}\nStatus: ${snapshot.status}\nSignals: ${signals}\nFollow-up: ${snapshot.followup}`,
    permission: (caregiverName, signal) => `Shared with: ${caregiverName}\nOnly if: ${signal} repeats\nScope: this follow-up only`,
    beeLink: (linkCode, days) => `Link code: ${linkCode}\nKeep it private and use it only with your own Bee account.\nUsed: only your own words and facts you confirmed in Bee\nStored: wellness signals only, never recordings or transcripts\nExpires in: ${days} days\nTo stop and delete Bee data, say: unlink my Bee`
};

const ALERT_STATUS = {
    notNeeded: 'No alert needed',
    sent: caregiverName => `${caregiverName} notified`,
    simulated: 'Notification simulated',
    noConsent: 'Not shared: no active consent'
};

const COPY = {
    welcome: 'Welcome to CarePulse. You can tell me how you feel, ask for a wellness summary, or schedule a check-in. How can I help?',
    missingSignal: 'What would you like me to record, for example tiredness, sleep, mood, or appetite?',
    missingStatus: 'Do you feel better, the same, or worse?',
    followupQuestion: time => `Would you like to check in again at ${spokenTime(time)}?`,
    followupReprompt: time => `Would you like a follow-up at ${spokenTime(time)}?`,
    dueFollowup: memberName => `${memberName}, we planned to check how you were feeling. Do you feel better, the same, or worse?`,
    consentQuestion: (caregiverName, signal) => `Do you authorize ${caregiverName} to receive a brief alert only if you report ${signal.replace(/-/g, ' ')} again during this follow-up?`,
    scheduleAndConsent: (time, caregiverName, signal) => `The check-in is scheduled for ${spokenTime(time)}. ${COPY.consentQuestion(caregiverName, signal)}`,
    consentIntroduction: (caregiverName, signal) => `Before I share anything, ${COPY.consentQuestion(caregiverName, signal).replace(/^Do /, 'do ')}`,
    noPending: memberName => `I do not have a pending check-in for ${memberName}. You can ask me to schedule one.`,
    alertSent: caregiverName => `Thank you. I recorded the follow-up and sent ${caregiverName} the brief alert you authorized.`,
    alertUnavailable: caregiverName => `Thank you. I recorded the follow-up. The authorized alert was prepared, but the notification service is unavailable, so please contact ${caregiverName} directly.`,
    noPermission: 'Thank you. I recorded the follow-up, but I did not share it because there is no active permission.',
    noAlert: status => `Thank you. I recorded that you feel ${status}. No caregiver alert was needed.`,
    summaryShort: (memberName, timeframe, snapshot) => `${memberName}'s ${timeframe} summary: ${snapshot.status}. ${snapshot.eventCount} wellness reports. Follow-up: ${snapshot.followup}.`,
    summaryDetailed: (memberName, timeframe, snapshot, signals) => `${memberName}'s ${timeframe} summary: ${snapshot.status}. I found ${snapshot.eventCount} wellness reports covering ${signals}. Follow-up: ${snapshot.followup}.`,
    consentSaved: caregiverName => `Done. Your permission applies only to this follow-up, and no other information will be shared with ${caregiverName}.`,
    yesWithoutContext: 'What would you like me to help with?',
    followupDeclined: 'Okay. I recorded the wellness update without creating a follow-up.',
    consentDeclined: 'Okay. The follow-up remains scheduled, but I will not share it with anyone.',
    okay: 'Okay.',
    emergency: 'CarePulse cannot handle emergencies. If someone may be in immediate danger, call your local emergency number now or ask a nearby person for help.',
    help: 'Try saying, I feel more tired than usual, schedule a check-in at six, or give me my wellness summary. You can also say, use short summaries.',
    goodbye: 'Take care.',
    fallback: 'I can record a wellness signal, create a follow-up, or show a simple weekly summary. What would you like to do?',
    error: 'I am sorry, something went wrong. Please try again.',
    preferenceHelp: 'You can say, use short summaries, use detailed summaries, set my follow-up time to eight PM, or turn off follow-up suggestions.',
    preferenceInvalidLength: 'Please choose short or detailed summaries.',
    preferenceInvalidOffers: 'Please say turn on or turn off follow-up suggestions.',
    preferenceInvalidTime: 'Please say a specific time, such as eight PM.',
    preferenceSaved: parts => `Saved your preferences: ${parts.join(', ')}.`,
    reportSavedWithoutOffer: observation => /^I recorded\b/i.test(observation) ? observation : `I saved your report. ${observation}`,
    preferenceTime: time => `follow-ups at ${spokenTime(time)}`,
    beeConsentQuestion: days => `Before I use your Bee data, here is what that means. CarePulse will look only at things you said yourself and facts you confirmed in Bee, to notice signals like tiredness or low mood. What other people say is ignored. I keep only those signals, never recordings or transcripts. This permission lasts ${days} days, and you can say unlink my Bee at any time to remove it and delete that data. Do you authorize CarePulse to use your Bee data?`,
    beeConsentSaved: 'Done. I sent your Bee link code to the Alexa app. Keep it private and use it only with your own Bee account.',
    beeConsentDeclined: 'Okay. I will not use any Bee data.',
    beeUnlinkQuestion: 'This stops CarePulse from using your Bee data and deletes the wellness signals that came from Bee. Your voice reports stay. Do you want to continue?',
    beeUnlinked: count => `Done. Bee is unlinked, and I deleted ${count} ${count === 1 ? 'wellness signal' : 'wellness signals'} that came from Bee.`,
    beeNothingToRemove: 'Bee is not linked to CarePulse, and there is no Bee data to remove.',
    beeUnlinkCancelled: 'Okay. Bee stays linked.'
};

module.exports = { CARD_TITLES, CARD_CONTENT, ALERT_STATUS, COPY };

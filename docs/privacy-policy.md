# CarePulse Privacy Policy

_Last updated: October 14, 2026_

CarePulse is a voice-first family wellness assistant for Alexa and Alexa+. It records wellness check-ins that you choose to share, compares them with your usual routine, and, only with your explicit permission, sends a brief alert to a caregiver you name. CarePulse is not a medical device, does not diagnose, and is not an emergency service.

## What we collect

- **Account data for Alexa+ account linking:** the email address and password you use to sign in to CarePulse. Amazon Cognito stores the password; CarePulse never sees it.
- **Wellness reports you give by voice:** the signal you report (for example tiredness, sleep, mood, or appetite), its intensity, optional sleep hours, and when you reported it.
- **Care settings:** member name, caregiver name, time zone, summary length, follow-up time, and discreet mode.
- **Follow-ups and permissions:** scheduled check-ins, their results, and the consent records that allow or deny caregiver alerts.
- **Bee wearable context (only if you say "link my Bee" and agree):** CarePulse analyzes only what you said yourself and facts you confirmed in Bee. It stores the derived signal (for example "tiredness: moderate"), never recordings or transcripts. Words spoken by other people are discarded.

## How we use it

- To answer your requests, such as recording a report or reading your wellness summary.
- To compare recent reports with your usual routine and offer a follow-up.
- To send a caregiver alert only when you granted permission for that caregiver, that signal, and that follow-up, and you report feeling the same or worse at the check-in.

We do not sell your data, use it for advertising, or share it with anyone other than the caregiver you authorize.

## Retention

- Wellness reports and Bee-derived signals: deleted automatically after 90 days.
- Caregiver alert permission: expires after at most 36 hours and applies to one follow-up.
- Bee permission: expires after 30 days.
- Service logs: kept for 14 days and do not contain your reports.
- Encrypted database backups (point-in-time recovery) may retain deleted data for up to 35 days.

## Your choices

- **Stop sharing Bee data:** say "Alexa, ask CarePulse to unlink my Bee". This revokes the permission, invalidates the link code, and deletes every Bee-derived signal.
- **Decline a caregiver alert:** answer "no" when CarePulse asks; the follow-up still happens but nothing is shared.
- **Unlink your account:** disable CarePulse or unlink the account in the Alexa app.
- **Delete your data or ask a question:** open an issue at https://github.com/LucioD3v/Care_Pulse/issues without including personal details, and we will contact you to verify and process the request.

## Security

Data is stored in Amazon DynamoDB with encryption at rest, transmitted over HTTPS, and accessed only by CarePulse services with least-privilege permissions. Caregiver notifications use Amazon SNS with an encryption key managed by CarePulse.

## Changes

We will update this page when CarePulse's data practices change and revise the date above.

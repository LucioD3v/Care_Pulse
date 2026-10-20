'use strict';

const alexa = require('./alexa_handlers');
const { withRequest } = require('./observability');
const { fromAlexa, withPrincipal, AccessError } = require('./access_control');

exports._private = alexa._private;
exports.handler = function handler(event, context, callback) {
    const result = withRequest('alexa', context, 6500, async () => {
        try {
            const appId = event.context?.System?.application?.applicationId || event.session?.application?.applicationId;
            if (process.env.CAREPULSE_ALEXA_SKILL_ID && appId !== process.env.CAREPULSE_ALEXA_SKILL_ID) throw new AccessError();
            // Emergency guidance must remain available even before profile setup.
            const emergency = event.request?.intent?.name === 'EmergencyGuidanceIntent';
            const principal = emergency ? null : await fromAlexa(event);
            return await withPrincipal(principal, () => new Promise((resolve, reject) => {
                alexa.handler(event, context, (error, response) => error ? reject(error) : resolve(response));
            }));
        } catch (error) {
            if (!(error instanceof AccessError)) throw error;
            return { version: '1.0', response: { shouldEndSession: true,
                outputSpeech: { type: 'PlainText', text: 'Your care profile is not authorized yet. Complete secure profile setup before recording or sharing information.' } } };
        }
    });
    if (callback) {
        result.then(response => callback(null, response), callback);
        return;
    }
    return result;
};

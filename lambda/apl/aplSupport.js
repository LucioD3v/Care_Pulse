'use strict';

const Alexa = require('ask-sdk-core');

function supportsAPL(handlerInput) {
    return Boolean(Alexa.getSupportedInterfaces(handlerInput.requestEnvelope)?.['Alexa.Presentation.APL']);
}

function addAPLIfSupported(handlerInput, directive, responseBuilder) {
    if (supportsAPL(handlerInput)) {
        responseBuilder.addDirective(directive);
    }
    return responseBuilder;
}

function isAPLUserEvent(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent';
}

module.exports = { supportsAPL, addAPLIfSupported, isAPLUserEvent };

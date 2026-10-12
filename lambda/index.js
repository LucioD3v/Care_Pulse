'use strict';

const alexa = require('./alexa_handlers');
const { withRequest } = require('./observability');

exports._private = alexa._private;
exports.handler = function handler(event, context, callback) {
    const result = withRequest('alexa', context, 6500, () => new Promise((resolve, reject) => {
        alexa.handler(event, context, (error, response) => error ? reject(error) : resolve(response));
    }));
    if (callback) {
        result.then(response => callback(null, response), callback);
        return;
    }
    return result;
};

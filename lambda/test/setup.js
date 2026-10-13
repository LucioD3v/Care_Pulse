'use strict';

if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('Test setup must not run in Lambda.');
process.env.CARE_MODE = 'demo';
process.env.CARE_STORAGE_MODE = 'memory';

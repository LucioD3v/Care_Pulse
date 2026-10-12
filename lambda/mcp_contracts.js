'use strict';

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { MCP_TOOLS } = require('./mcp_tools');
const ajv = new Ajv({ allErrors: false, strict: true });
addFormats(ajv);
const inputs = new Map(MCP_TOOLS.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
const outputs = new Map(MCP_TOOLS.map(tool => [tool.name, ajv.compile(tool.outputSchema)]));

function validateToolInput(name, input) {
    const validate = inputs.get(name);
    if (!validate || !validate(input)) throw new TypeError('Invalid tool arguments.');
}

function project(value, schema) {
    if (value === null || value === undefined) return value;
    if (schema.type === 'object') {
        return Object.fromEntries(Object.entries(schema.properties)
            .filter(([key]) => value[key] !== undefined)
            .map(([key, child]) => [key, project(value[key], child)]));
    }
    if (schema.type === 'array') return value.map(item => project(item, schema.items));
    return value;
}

async function callMcpTool(name, input) {
    validateToolInput(name, input);
    const service = require('./care_service');
    const result = name === 'get_wellness_history'
        ? await service.getWellnessHistoryPage(input) : await service.callTool(name, input);
    const dto = project(result, MCP_TOOLS.find(tool => tool.name === name).outputSchema);
    if (!outputs.get(name)(dto)) throw new Error('Invalid tool output.');
    return dto;
}

module.exports = { validateToolInput, callMcpTool };

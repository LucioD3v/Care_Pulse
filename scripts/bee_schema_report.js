#!/usr/bin/env node
'use strict';

// Prints the field structure of Bee API responses without any values,
// so the shape can be shared safely to map it to ingest_bee_context.
// Usage: node scripts/bee_schema_report.js facts.json conversations.json

const fs = require('node:fs');
const path = require('node:path');

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

function collect(value, prefix, shapes) {
    const type = typeOf(value);
    const key = prefix || '(root)';
    if (!shapes.has(key)) shapes.set(key, new Set());
    shapes.get(key).add(type);
    if (type === 'array') {
        for (const item of value) collect(item, `${prefix}[]`, shapes);
    } else if (type === 'object') {
        for (const [field, child] of Object.entries(value)) {
            collect(child, prefix ? `${prefix}.${field}` : field, shapes);
        }
    }
}

function report(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const shapes = new Map();
    collect(data, '', shapes);
    const lines = [`# ${path.basename(file)}`];
    for (const [field, types] of [...shapes].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${field}: ${[...types].sort().join(' | ')}`);
    }
    return lines.join('\n');
}

const files = process.argv.slice(2);
if (!files.length) {
    console.error('Usage: node scripts/bee_schema_report.js <file.json> [more.json]');
    process.exit(1);
}
console.log(files.map(report).join('\n\n'));

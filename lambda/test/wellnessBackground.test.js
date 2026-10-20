'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWellnessSnapshotPayload, wellnessSnapshotDirective } = require('../apl/wellnessSnapshotPayload');

afterEach(() => delete process.env.CAREPULSE_WELLNESS_BACKGROUND_URL);

test('wellness snapshot includes only a public HTTPS background', () => {
    process.env.CAREPULSE_WELLNESS_BACKGROUND_URL = 'https://assets.example.test/wellness-background.png';
    assert.equal(buildWellnessSnapshotPayload().backgroundImageUrl,
        'https://assets.example.test/wellness-background.png');

    process.env.CAREPULSE_WELLNESS_BACKGROUND_URL = 'http://assets.example.test/insecure.png';
    assert.equal(buildWellnessSnapshotPayload().backgroundImageUrl, '');
});

test('packaged wellness templates stay identical and bind the configured background', () => {
    process.env.CAREPULSE_WELLNESS_BACKGROUND_URL = 'https://assets.example.test/wellness-background.png';
    const directive = wellnessSnapshotDirective({ memberName: 'Elena' });
    assert.equal(directive.datasources.wellnessData.backgroundImageUrl,
        'https://assets.example.test/wellness-background.png');
    assert.match(JSON.stringify(directive.document), /wellnessData\.backgroundImageUrl/);

    const packaged = fs.readFileSync(path.join(__dirname, '../apl/wellnessSnapshot.json'), 'utf8');
    const skillPackage = fs.readFileSync(path.join(__dirname,
        '../../skill-package/assets/documents/wellnessSnapshot.json'), 'utf8');
    assert.equal(packaged, skillPackage);
});

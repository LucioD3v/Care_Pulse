'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const target = fs.mkdtempSync(path.join(os.tmpdir(), 'carepulse-validation-'));
const lambda = path.join(target, 'lambda');

function run(command, args) {
    const result = spawnSync(command, args, { cwd: lambda, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Validation command failed.');
}

try {
    for (const relative of ['lambda', 'skill-package', 'scripts', 'serverless.yml', 'infrastructure/cfn-deployer']) {
        fs.cpSync(path.join(root, relative), path.join(target, relative), {
            recursive: true,
            filter: name => path.basename(name) !== 'node_modules' && !path.basename(name).startsWith('.env')
        });
    }
    run('npm', ['ci']);
    run('npm', ['test']);
    run('npm', ['ci', '--omit=dev']);
    const archive = path.join(target, 'carepulse-lambda.zip');
    const extracted = path.join(target, 'extracted');
    run('python3', [path.join(root, 'scripts/package_lambda.py'), lambda, archive]);
    run('python3', ['-m', 'zipfile', '-e', archive, extracted]);
    run(process.execPath, ['-e', "for (const name of ['index', 'mcp_http', 'followup_monitor', 'aws-services']) require(" + JSON.stringify(extracted) + " + '/' + name)"]);
    console.log('Clean installation, all test suites, and extracted Lambda entry points passed.');
    console.log('Temporary validation directory: ' + target);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}

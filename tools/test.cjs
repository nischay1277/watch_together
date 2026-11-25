const { root } = require('./task-env.cjs');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const files = readdirSync(join(root, 'test')).filter(file => file.endsWith('.test.cjs')).map(file => join(root, 'test', file));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);

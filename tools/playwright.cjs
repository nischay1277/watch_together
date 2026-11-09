const { root } = require('./task-env.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(result.status || 0);

const { root } = require('./task-env.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cli = require.resolve('electron-builder/out/cli/cli.js');
const packed = spawnSync(process.execPath, [cli, '--win', 'dir', '--x64', '-c.electronDist=node_modules/electron/dist'], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
if (packed.status !== 0) process.exit(packed.status || 1);
if (process.argv.includes('--unpacked')) process.exit(0);
const compiled = spawnSync('python', [path.join(root, 'tools/package-windows.py')], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
process.exit(compiled.status || 0);

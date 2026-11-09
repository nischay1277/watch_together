require('./task-env.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const { createTogetherServer } = require('../server.cjs');
const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');

function waitMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const listener = raw => { const message = JSON.parse(raw); if (predicate(message)) { clearTimeout(timeout); socket.off('message', listener); resolve(message); } };
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error('Room check timed out.')); }, 12000);
    socket.on('message', listener);
  });
}
(async () => {
  const service = await createTogetherServer({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${service.port}`;
  const hosts = [];
  const createHost = async name => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws'); hosts.push(socket);
    const welcome = waitMessage(socket, message => message.type === 'welcome');
    socket.once('open', () => socket.send(JSON.stringify({ type: 'create', name })));
    return { socket, room: await welcome };
  };
  const uriFor = code => { const uri = new URL('together-watch://join'); uri.searchParams.set('server', origin); uri.searchParams.set('code', code); return uri.href; };
  const first = await createHost('First fixture host');
  const second = await createHost('Second fixture host');
  const env = { ...process.env, TOGETHER_TEST: '1', TOGETHER_TEST_PROFILE: `deep-link-${process.pid}` }; delete env.ELECTRON_RUN_AS_NODE;
  let app, other;
  try {
    app = await electron.launch(process.argv[2]
      ? { executablePath: path.resolve(process.argv[2]), args: [uriFor(first.room.code)], env }
      : { args: [root, uriFor(first.room.code)], env });
    const page = await app.firstWindow();
    await expect(page.locator('#invitation-title')).toContainText(first.room.code.slice(0, 8));
    await expect(page.locator('#create-room')).toBeHidden();
    await expect(page.locator('#server-url')).toHaveValue(origin);
    await page.locator('#display-name').fill('App link guest');
    const joinedFirst = waitMessage(first.socket, message => message.type === 'members' && message.members.length === 2);
    await page.locator('#join-room').click(); await joinedFirst;
    await expect(page.locator('#room-active')).toBeVisible();
    await expect(page.locator('#status')).toContainText('Joined. Waiting');
    const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
    const args = process.argv[2] ? [uriFor(second.room.code)] : [root, uriFor(second.room.code)];
    other = spawn(executable, args, { env, windowsHide: true, stdio: 'ignore' });
    const exited = new Promise(resolve => other.once('exit', resolve));
    await expect(page.locator('#status')).toContainText('Leave your current room');
    await exited;
    await page.locator('#leave-room').click();
    await expect(page.locator('#invitation-title')).toContainText(second.room.code.slice(0, 8));
    const joinedSecond = waitMessage(second.socket, message => message.type === 'members' && message.members.length === 2);
    await page.locator('#join-room').click(); await joinedSecond;
    await expect(page.locator('#room-title')).toContainText(second.room.code.slice(0, 8));
    await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    console.log('Cold and already-running app links joined the exact supplied server and room; no camera/microphone was opened.');
  } catch (error) {
    if (app) console.error('App-link diagnostics:', await app.evaluate(({ app }) => ({ profile: app.getPath('userData'), argv: process.argv })).catch(() => null));
    throw error;
  } finally { if (other && other.exitCode === null) other.kill(); await app?.close(); for (const socket of hosts) socket.terminate(); await service.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

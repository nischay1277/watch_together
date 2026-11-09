require('./task-env.cjs');
const { createTogetherServer } = require('../server.cjs');
const { InternetTunnel } = require('../desktop/internet.cjs');
const WebSocket = require('ws');
const path = require('node:path');
const fs = require('node:fs');

function firstMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', raw => resolve(JSON.parse(raw)));
    socket.once('error', reject);
    setTimeout(() => reject(new Error('Public WebSocket timed out.')), 20000).unref();
  });
}
(async () => {
  const server = await createTogetherServer({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const tunnel = new InternetTunnel({ binaryPath: path.join(__dirname, '../vendor/cloudflared.exe'), origin, onState: state => server.setPublicUrl(state.url) });
  let host, guest;
  try {
    const state = await tunnel.start();
    let reachable = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const health = await fetch(`${state.url}/health`, { signal: AbortSignal.timeout(6000) }).then(r => r.json());
        if (health.status === 'ok') { reachable = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!reachable) throw new Error('The tunnel connected but the public HTTPS endpoint could not be reached.');
    host = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    const welcomePromise = firstMessage(host);
    host.once('open', () => host.send(JSON.stringify({ type: 'create', name: 'Public connection test' })));
    const welcome = await welcomePromise;
    if (welcome.type !== 'welcome') throw new Error('Test host failed to create a room.');
    guest = new WebSocket(state.url.replace('https:', 'wss:') + '/ws', { origin: state.url });
    const joinedPromise = firstMessage(guest);
    guest.once('open', () => guest.send(JSON.stringify({ type: 'join', code: welcome.code, name: 'Remote connection test' })));
    const joined = await joinedPromise;
    if (joined.type !== 'welcome' || joined.hostId !== welcome.selfId) throw new Error('Public meeting-code join failed.');
    const report = { testedAt: new Date().toISOString(), https: true, publicWebSocket: true, meetingCodeJoin: true, service: 'Cloudflare Quick Tunnel', stoppedAfterTest: true };
    fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '../artifacts/internet-test.json'), JSON.stringify(report, null, 2));
    console.log('Public HTTPS, secure WebSocket, and meeting-code joining passed. No screen, camera, or microphone was captured.');
  } finally { guest?.terminate(); host?.terminate(); tunnel.stop(); await server.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

// Attach to a test-launched portable app whose outer launcher does not forward
// Electron's debugger stderr for the normal Playwright Electron launcher.
require('./task-env.cjs');
const { chromium, expect } = require('@playwright/test');
const WebSocket = require('ws');

(async () => {
  const ports = process.argv.slice(2, 4).map(Number);
  const expectedInvitation = process.argv[4];
  if (ports.length !== 2 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Provide the test instance Node inspector and browser debugging ports.');
  const metadata = await Promise.all(ports.map(async port => {
    for (let attempt = 0; attempt < 240; attempt++) {
      try { return { port, version: await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()) }; }
      catch (error) { if (attempt === 239) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
  }));
  const node = metadata.find(entry => entry.version.Browser?.startsWith('node.js'));
  const chrome = metadata.find(entry => entry.version.Browser?.includes('Chrome'));
  if (!node || !chrome) throw new Error('Expected the test app’s Node and Chromium debugging endpoints.');
  const nodeTarget = (await fetch(`http://127.0.0.1:${node.port}/json/list`).then(r => r.json()))[0];
  const socket = new WebSocket(nodeTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const pending = new Map();
  socket.on('close', () => { for (const operation of pending.values()) operation.reject(new Error('Test app closed.')); pending.clear(); });
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const operation = pending.get(message.id); pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) operation.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      else operation.resolve(message.result);
    }
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
  let viewerBrowser;
  try {
    const page = browser.contexts()[0].pages().find(page => page.url().startsWith('http://127.0.0.1:'));
    if (!page) throw new Error('Together renderer not found.');
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    await expect(page).toHaveTitle(new RegExp(require('../package.json').version.replace(/\./g, '\\.')));
    const details = await page.evaluate(() => window.togetherDesktop.getInfo());
    expect(details.dataRoot.toLowerCase().startsWith(require('node:path').resolve(__dirname, '../release/Together-data').toLowerCase())).toBe(true);
    await expect(page.locator('#resolution')).toHaveValue('0');
    await expect(page.locator('#bitrate')).toHaveValue('0');
    if (expectedInvitation) {
      const invitation = new URL(expectedInvitation);
      await expect(page.locator('#invitation-title')).toContainText(invitation.searchParams.get('code').slice(0, 8));
      await expect(page.locator('#server-url')).toHaveValue(invitation.searchParams.get('server'));
      await expect(page.locator('#create-room')).toBeHidden();
      await page.locator('#clear-invitation').click();
    }
    const registration = await evaluate(`(() => {
      const {app}=process.mainModule.require('electron');
      const scheme='together-watch-qa-'+process.pid;
      const executable=process.env.PORTABLE_EXECUTABLE_FILE||process.execPath;
      const registered=app.setAsDefaultProtocolClient(scheme,executable,[]);
      const matches=app.isDefaultProtocolClient(scheme,executable,[]);
      app.removeAsDefaultProtocolClient(scheme,executable,[]);
      return registered&&matches;
    })()`);
    expect(registration.result.value).toBe(true);
    await page.locator('#display-name').fill('Portable test');
    await page.locator('#create-room').click();
    await expect(page.locator('#room-active')).toBeVisible();
    if (process.env.TOGETHER_TEST_INTERNET === '1') {
      await page.locator('#start-internet').click();
      await expect(page.locator('#room-code')).toContainText('trycloudflare.com', { timeout: 70000 });
      await page.locator('#stop-internet').click();
      await expect(page.locator('#room-code')).not.toContainText('trycloudflare.com');
    }
    await evaluate(`(async () => {
      const {BrowserWindow}=process.mainModule.require('electron');
      const probe=new BrowserWindow({width:700,height:440,title:'Portable capture test',show:true,skipTaskbar:true,webPreferences:{sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
      globalThis.__togetherPortableProbe=probe;
      await probe.loadURL('data:text/html,'+encodeURIComponent('<title>Portable capture test</title><body style="background:#d5ee9f;font:32px sans-serif">Together portable capture test<canvas width="600" height="300"></canvas><script>const c=document.querySelector("canvas").getContext("2d");let n=0;setInterval(()=>{c.fillStyle="hsl("+(n++%360)+" 50% 30%)";c.fillRect(0,0,600,300);c.fillStyle="#fff";c.fillRect(n*11%600,40,70,70)},16)</script>'));
      return true;
    })()`);
    await page.locator('#system-audio').uncheck();
    await page.locator('#share-screen').click();
    await expect(page.locator('#source-dialog')).toBeVisible();
    await page.locator('#source-window-tab').click();
    await page.locator('#source-list button').filter({ hasText: 'Portable capture test' }).click();
    await expect(page.locator('#share-screen')).toHaveText('Stop sharing', { timeout: 20000 });
    await expect(page.locator('#screen-video')).toBeVisible();
    const settings = await page.locator('#screen-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings());
    viewerBrowser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const viewer = await viewerBrowser.newPage();
    const origin = new URL(page.url()).origin;
    const room = new URLSearchParams((await page.locator('#room-code').textContent()).split('#')[1]).get('code');
    await viewer.goto(origin);
    await viewer.locator('#display-name').fill('Portable verification viewer');
    await viewer.locator('#meeting-code').fill(`${origin}/#code=${room}`);
    await viewer.locator('#join-room').click();
    await expect(viewer.locator('#room-active')).toBeVisible();
    await expect.poll(() => viewer.locator('#screen-video').evaluate(video => video.currentTime), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(page.locator('#video-health')).toContainText('encoded stream');
    await page.locator('.media-details summary').click();
    await viewer.locator('.media-details summary').click();
    await expect(page.locator('#media-diagnostics')).toContainText('Capture input');
    await expect(page.locator('#media-diagnostics')).toContainText(/Codec (VP8|VP9|H264|H265|AV1)/);
    await expect(viewer.locator('#media-diagnostics')).toContainText('Received');
    await expect(viewer.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(viewer.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    const diagnostics = { host: await page.locator('#media-diagnostics').textContent(), viewer: await viewer.locator('#media-diagnostics').textContent() };
    await page.screenshot({ path: require('node:path').resolve(__dirname, '../artifacts/portable-diagnostics.png'), fullPage: true });
    await viewer.locator('#leave-room').click();
    await page.locator('#share-screen').click();
    await page.locator('#leave-room').click();
    await expect(page.locator('#room-entry')).toBeVisible();
    console.log('Exact portable executable passed launch, room creation, native source selection, capture, stop, and leave:', JSON.stringify(settings));
    console.log('Packaged host and viewer telemetry:', JSON.stringify(diagnostics));
  } finally {
    await viewerBrowser?.close().catch(() => {});
    await evaluate("process.mainModule.require('electron').app.quit()").catch(() => {});
    socket.close();
    await browser.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

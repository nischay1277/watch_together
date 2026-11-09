require('./task-env.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

(async () => {
  const env = { ...process.env, TOGETHER_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [], env }
    : { args: [path.join(__dirname, '..')], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    const storage = await page.evaluate(() => window.togetherDesktop.getInfo());
    expect(storage.dataRoot.startsWith(path.parse(path.join(__dirname, '..')).root)).toBe(true);
    await expect(page.locator('#server-url')).toHaveValue(/http:\/\/127\.0\.0\.1:\d+/);
    await page.locator('#display-name').fill('Desktop test');
    await page.locator('#create-room').click();
    await expect(page.locator('#room-active')).toBeVisible();
    if (process.env.TOGETHER_TEST_INTERNET === '1') {
      await page.locator('#start-internet').click();
      await expect(page.locator('#room-code')).toContainText('trycloudflare.com', { timeout: 70000 });
      const invite = new URL(await page.locator('#room-code').textContent());
      const roomCode = new URLSearchParams(invite.hash.slice(1)).get('code') || invite.pathname.slice(1);
      const guest = new WebSocket(invite.origin.replace('https:', 'wss:') + '/ws', { origin: invite.origin });
      try {
        const joined = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Public packaged-app join timed out.')), 20000);
          guest.on('error', error => { clearTimeout(timeout); reject(error); });
          guest.once('message', raw => { clearTimeout(timeout); resolve(JSON.parse(raw)); });
          guest.once('open', () => guest.send(JSON.stringify({ type: 'join', code: roomCode, name: 'Packaged public test' })));
        });
        expect(joined.type).toBe('welcome');
      } finally { guest.terminate(); }
      await page.locator('#stop-internet').click();
      await expect(page.locator('#room-code')).not.toContainText('trycloudflare.com');
      console.log('Desktop public-address button and secure internet meeting-code join passed.');
    }
    // Real camera/microphone are deliberately left off; browser tests use fake devices.
    await expect(page.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({ width: 1400, height: 900, title: 'Capture test pattern', show: true, skipTaskbar: true, webPreferences: { sandbox: true, nodeIntegration: false } });
      globalThis.__togetherSmokeWindow = probe;
      await probe.loadURL('data:text/html,<title>Capture test pattern</title><body style="margin:0;background:%23d5ee9f;font:36px sans-serif;display:grid;place-content:center;height:100vh">Together capture test</body>');
    });
    // Capture only this test pattern, never a user's desktop or applications.
    await page.locator('#system-audio').uncheck();
    await page.locator('#share-screen').click();
    await expect(page.locator('#source-dialog')).toBeVisible();
    await expect(page.locator('#source-screen-tab')).toHaveAttribute('aria-selected', 'true');
    expect(await page.locator('#source-list [data-source-kind="screen"]').count()).toBeGreaterThan(0);
    await page.locator('#source-window-tab').click();
    await page.locator('#source-list button').filter({ hasText: 'Capture test pattern' }).first().click();
    await expect(page.locator('#share-screen')).toHaveText('Stop sharing', { timeout: 20000 }).catch(async error => {
      console.error('Native capture status:', await page.locator('#status').textContent());
      fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
      await page.screenshot({ path: path.join(__dirname, '../artifacts/native-failure.png'), fullPage: true });
      throw error;
    });
    await expect(page.locator('#screen-video')).toBeVisible();
    const capture = await page.locator('#screen-video').evaluate(video => ({
      settings: video.srcObject.getVideoTracks()[0].getSettings(),
      state: video.srcObject.getVideoTracks()[0].readyState,
      width: video.videoWidth, height: video.videoHeight,
    }));
    expect(capture.state).toBe('live');
    await page.locator('#resolution').selectOption('720');
    await expect.poll(() => page.locator('#screen-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings().height)).toBeLessThanOrEqual(720);
    const lowerHeight = await page.locator('#screen-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings().height);
    await page.locator('#resolution').selectOption('2160');
    await expect.poll(() => page.locator('#screen-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings().height)).toBeGreaterThan(lowerHeight);
    await expect(page.locator('#quality-summary')).toContainText('True 4K needs a 4K source');
    await page.locator('#resolution').selectOption('0');
    await expect(page.locator('#quality-summary')).toContainText('Original/source resolution');
    await page.locator('#fps').selectOption('240');
    await expect(page.locator('#status')).toContainText('240 FPS requested');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')).show());
    await page.locator('#fullscreen').click();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    expect(await page.locator('#stage').evaluate(stage => Math.abs(stage.getBoundingClientRect().height - innerHeight) < 2)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await page.locator('#copy-code').click();
    const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(clipboard).toMatch(/\/#code=[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/);
    fs.mkdirSync(path.join(__dirname, '../artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../artifacts/desktop-native.png'), fullPage: true });
    fs.writeFileSync(path.join(__dirname, '../artifacts/native-capture.json'), JSON.stringify(capture, null, 2));
    await page.locator('#share-screen').click();
    await expect(page.locator('#screen-video')).toBeHidden();
    await page.locator('#leave-room').click();
    await expect(page.locator('#room-entry')).toBeVisible();
    expect(errors).toEqual([]);
    console.log('Native desktop smoke passed. Test-window capture:', JSON.stringify(capture));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

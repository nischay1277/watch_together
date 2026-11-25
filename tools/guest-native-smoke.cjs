require('./task-env.cjs');
const { _electron: electron, chromium, expect } = require('@playwright/test');
const { createTogetherServer } = require('../server.cjs');
const path = require('node:path');
const root = path.join(__dirname, '..');
(async () => {
  const service = await createTogetherServer({ host: '127.0.0.1', port: 0 });
  let browser, app;
  try {
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const host = await browser.newPage();
    const origin = `http://127.0.0.1:${service.port}`;
    await host.goto(origin); await host.locator('#display-name').fill('Browser host'); await host.locator('#create-room').click();
    const code = new URLSearchParams((await host.locator('#room-code').textContent()).split('#')[1]).get('code');
    const invitation = new URL('together-watch://join'); invitation.searchParams.set('server', origin); invitation.searchParams.set('code', code);
    const env = { ...process.env, TOGETHER_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [invitation.href], env } : { args: [root, invitation.href], env });
    const guest = await app.firstWindow(); await expect(guest.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    await guest.locator('#display-name').fill('Desktop guest'); await guest.locator('#join-room').click();
    await expect(guest.locator('#room-title')).toContainText('Watching together');
    await expect(guest.locator('#share-screen')).toBeEnabled();
    await app.evaluate(async ({ BrowserWindow }) => {
      const probe = new BrowserWindow({ width: 800, height: 500, title: 'Guest sharing fixture', show: true, webPreferences: { sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
      globalThis.qaGuestSource = probe;
      await probe.loadURL('data:text/html,' + encodeURIComponent('<title>Guest sharing fixture</title><body style="background:#d5ee9f;font:32px sans-serif">Guest screen sharing<canvas width="700" height="350"></canvas><script>const c=document.querySelector("canvas").getContext("2d");let n=0;setInterval(()=>{c.fillStyle="hsl("+(n++%360)+" 50% 25%)";c.fillRect(0,0,700,350);c.fillStyle="#fff";c.fillRect(n*10%650,40,50,50)},16)</script>'));
    });
    await guest.locator('#system-audio').uncheck(); await guest.locator('#share-screen').click();
    await guest.locator('#source-window-tab').click();
    await guest.locator('#source-list button').filter({ hasText: 'Guest sharing fixture' }).click();
    await expect(guest.locator('#share-screen')).toHaveText('Stop sharing');
    await expect(host.locator('#stage-caption')).toHaveText('Desktop guest is sharing');
    await expect.poll(() => host.locator('#screen-video').evaluate(video => video.currentTime), { timeout: 20000 }).toBeGreaterThan(0);
    await expect(host.locator('#share-screen')).toBeDisabled();
    await expect(guest.locator('#video-health')).toContainText('encoded stream');
    await expect(guest.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(guest.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    await guest.locator('.media-details summary').click();
    await guest.screenshot({ path: path.join(root, 'artifacts/guest-native-sharing.png'), fullPage: true });
    await guest.locator('#share-screen').click(); await expect(host.locator('#share-screen')).toBeEnabled();
    await guest.locator('#leave-room').click();
    await expect(host.locator('#room-active')).toBeVisible(); await expect(host.locator('#member-count')).toContainText('1 /');
    console.log('Packaged desktop guest passed native source selection, generated-window sharing, remote playback, stop, and guest exit without ending the host room.');
  } finally { await app?.close().catch(() => {}); await browser?.close().catch(() => {}); await service.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

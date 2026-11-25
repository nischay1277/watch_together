require('./task-env.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const path = require('node:path');
const WebSocket = require('ws');
const root = path.join(__dirname, '..');

// Keep the real user's profile, parties and devices untouched. This same isolated
// profile is reopened to verify persistence, rather than creating fresh state.
const profile = `party-smoke-${process.pid}-${Date.now()}`;
const env = { ...process.env, TOGETHER_TEST: '1', TOGETHER_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  return electron.launch(process.argv[2]
    ? { executablePath: path.resolve(process.argv[2]), args: [], env }
    : { args: [root], env });
}
async function joinGuest(origin, code) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, { origin });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Native party guest timed out.')); }, 10000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('message', raw => {
      const data = JSON.parse(raw);
      if (data.type === 'welcome') { clearTimeout(timer); resolve(); }
      else if (data.type === 'error') { clearTimeout(timer); reject(new Error(data.message)); }
    });
    socket.once('open', () => socket.send(JSON.stringify({ type: 'join', code, name: 'Native party guest' })));
  });
  return socket;
}

(async () => {
  let app, guest;
  const errors = [];
  try {
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    const firstInfo = await page.evaluate(() => window.togetherDesktop.getInfo());
    expect(firstInfo.dataRoot.toLowerCase().startsWith(path.resolve(root).toLowerCase())).toBe(true);
    const network = await page.evaluate(() => window.togetherDesktop.getNetworkStatus());
    expect(['connected', 'stopped', 'missing', 'login-required', 'approval-required', 'unavailable']).toContain(network.state);
    expect(Object.keys(network).sort()).toEqual(['installed', 'ip', 'message', 'peers', 'setup', 'state']);
    // Report only the state, never account details, peer names or network addresses.
    console.log(`Native network check returned: ${network.state}.`);

    await page.locator('#display-name').fill('Native party host');
    await page.locator('#party-name').fill('Native persistent party');
    await page.locator('#create-party').click();
    await expect(page.locator('#room-active')).toBeVisible();
    const roomInvite = new URL(await page.locator('#room-code').textContent());
    const code = new URLSearchParams(roomInvite.hash.slice(1)).get('code');
    expect(code).toMatch(/^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/);
    await expect.poll(() => page.evaluate(() => window.togetherDesktop.getParties().then(parties => parties.length))).toBe(1);
    // Use loopback for this fixture; do not depend on the real user's VPN route.
    const loopbackInvite = `${firstInfo.localOrigin}/#code=${code}`;
    let favorites = await page.evaluate(({ invite }) => window.togetherDesktop.saveParty({ title: 'Native persistent party', invite }), { invite: loopbackInvite });
    for (const party of favorites.filter(party => party.invite !== loopbackInvite)) {
      favorites = await page.evaluate(id => window.togetherDesktop.removeParty(id), party.id);
    }
    expect(favorites).toHaveLength(1);
    const savedParty = favorites[0];
    await page.locator('#leave-room').click();
    await app.close(); app = null;

    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    const nextInfo = await page.evaluate(() => window.togetherDesktop.getInfo());
    expect(nextInfo.localOrigin).toBe(firstInfo.localOrigin);
    const restored = await page.evaluate(() => window.togetherDesktop.getParties());
    expect(restored).toEqual([savedParty]);
    guest = await joinGuest(nextInfo.localOrigin, code);
    await page.locator('#refresh-parties').click();
    const card = page.locator(`.party-card[data-party-id="${savedParty.id}"]`);
    await expect(card.locator('.party-presence')).toContainText('Native party guest', { timeout: 15000 });
    await expect(card.locator('.party-card-badge')).toHaveText('1 HERE');
    await card.locator('.party-join').click();
    await expect(page.locator('#room-active')).toBeVisible();
    await expect(page.locator('#room-code')).toContainText(code);
    await expect(page.locator('#member-count')).toContainText('2 /');
    await expect(page.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
    console.log('Native saved-party smoke passed: stable port, persistent room code, IPC favorites, live presence and one-click rejoin after app restart. No camera, mic, screen capture or paid/public server was opened.');
  } finally {
    guest?.terminate();
    await app?.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

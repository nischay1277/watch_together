const { test, expect } = require('@playwright/test');

test('first-time setup installs and signs in only when requested and detects progress inside Together', async ({ page }) => {
  await page.addInitScript(() => {
    let installed = false, connected = false;
    window.installCalls = 0; window.connectCalls = 0;
    const status = () => ({ state: connected ? 'connected' : installed ? 'login-required' : 'missing', installed,
      ip: connected ? '100.64.0.8' : null, peers: [], message: connected ? 'Connected in the background.' : installed ? 'Sign in once.' : 'Install once.' });
    window.togetherDesktop = {
      getInfo: async () => ({ localOrigin: location.origin, lanOrigin: location.origin, internet: { state: 'off', url: null } }),
      getNetworkStatus: async () => status(), installNetwork: async () => { window.installCalls++; installed = true; return { state: 'installer-open', message: 'Finish Windows setup.' }; },
      connectNetwork: async () => { window.connectCalls++; connected = true; return status(); },
      onInvitation() {}, onInternetState() {},
    };
  });
  await page.goto('/'); await expect(page.locator('#network-state')).toHaveText('Private network setup needed');
  await page.locator('#connect-network').click(); await expect(page.locator('#connection-setup')).toBeVisible();
  expect(await page.evaluate(() => window.installCalls)).toBe(0);
  await page.locator('#setup-install').click(); await expect(page.locator('#setup-install')).toHaveText('Installed');
  expect(await page.evaluate(() => window.installCalls)).toBe(1);
  expect(await page.evaluate(() => window.connectCalls)).toBe(0);
  await page.locator('#setup-login').click(); await expect(page.locator('#setup-login')).toHaveText('Connected');
  await page.locator('#setup-done').click(); await expect(page.locator('#connection-setup')).not.toBeVisible();
  await expect(page.locator('#network-state')).toHaveText('Private network connected');
  await expect(page.locator('#toggle-mic')).toBeDisabled();
});

test('a combined first-time invite guides network approval and joins the exact party without opening devices', async ({ browser }) => {
  const host = await browser.newPage(), guest = await browser.newPage();
  try {
    await guest.addInitScript(() => {
      window.acceptedInvites = [];
      window.togetherDesktop = {
        getInfo: async () => ({ localOrigin: location.origin, lanOrigin: location.origin, internet: { state: 'off', url: null } }),
        getNetworkStatus: async () => ({ state: 'connected', installed: true, ip: '100.64.0.8', peers: [], message: 'Connected.' }),
        acceptNetworkInvite: async url => { window.acceptedInvites.push(url); return { opened: true }; },
        onInvitation() {}, onInternetState() {},
      };
    });
    await host.goto('/'); await host.locator('#display-name').fill('Setup host');
    await host.locator('#party-name').fill('Easy first party'); await host.locator('#create-party').click();
    await expect(host.locator('#room-active')).toBeVisible();
    const first = new URL(await host.locator('#room-code').textContent());
    const code = new URLSearchParams(first.hash.slice(1)).get('code');
    const network = 'https://login.tailscale.com/uinv/test-only';
    first.hash = new URLSearchParams({ code, network }).toString();
    await guest.goto('/'); await guest.locator('#display-name').fill('Setup friend');
    await guest.locator('#meeting-code').fill(first.href);
    await expect(guest.locator('#connection-setup')).toBeVisible();
    await expect(guest.locator('#setup-network-link')).toHaveValue(network);
    expect(await guest.evaluate(() => window.acceptedInvites)).toEqual([]);
    await guest.locator('#setup-accept').click(); expect(await guest.evaluate(() => window.acceptedInvites)).toEqual([network]);
    await guest.locator('#setup-done').click(); await expect(guest.locator('#room-active')).toBeVisible();
    await expect(guest.locator('#room-code')).toContainText(code);
    await expect(host.locator('#participants .participant-tile')).toHaveCount(2);
    await expect(guest.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(guest.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
  } finally { await host.close(); await guest.close(); }
});

test('a host can copy one first-time invite while ordinary party invites stay unchanged', async ({ page }) => {
  await page.addInitScript(() => {
    window.clipboardCopy = '';
    window.togetherDesktop = {
      getInfo: async () => ({ localOrigin: location.origin, lanOrigin: location.origin, internet: { state: 'off', url: null } }),
      getNetworkStatus: async () => ({ state: 'connected', installed: true, ip: '100.64.0.8', peers: [], message: 'Connected.' }),
      writeClipboard: async text => { window.clipboardCopy = text; }, onInvitation() {}, onInternetState() {},
    };
  });
  await page.goto('/'); await page.locator('#display-name').fill('First invite host');
  await page.locator('#party-name').fill('One invite party'); await page.locator('#create-party').click();
  await expect(page.locator('#room-active')).toBeVisible();
  const normalInvite = await page.locator('#room-code').textContent();
  await page.locator('#network-help').click();
  await page.locator('#setup-network-link').fill('https://login.tailscale.com/uinv/intended-friend-only');
  await page.locator('#setup-copy').click();
  const copied = new URL(await page.evaluate(() => window.clipboardCopy));
  const fragment = new URLSearchParams(copied.hash.slice(1));
  expect(fragment.get('network')).toBe('https://login.tailscale.com/uinv/intended-friend-only');
  expect(fragment.get('code')).toBe(new URLSearchParams(new URL(normalInvite).hash.slice(1)).get('code'));
  await page.locator('#setup-close').click(); await page.locator('#copy-code').click();
  expect(await page.evaluate(() => window.clipboardCopy)).toBe(normalInvite);
});

test('saved networks are selected inside Together only on request and cannot switch during an active party', async ({ page }) => {
  await page.addInitScript(() => {
    let selected = 'own'; window.switchedNetworks = [];
    window.togetherDesktop = {
      getInfo: async () => ({ localOrigin: location.origin, lanOrigin: location.origin, internet: { state: 'off', url: null } }),
      getNetworkStatus: async () => ({ state: 'connected', installed: true, ip: '100.64.0.8', peers: [], message: 'Connected.' }),
      getNetworkProfiles: async () => [{ id: 'own', label: 'My network', selected: selected === 'own' }, { id: 'friend', label: 'Friend network', selected: selected === 'friend' }],
      switchNetwork: async id => { window.switchedNetworks.push(id); selected = id; },
      onInvitation() {}, onInternetState() {},
    };
  });
  await page.goto('/'); await page.locator('#network-help').click();
  await page.locator('.setup-networks summary').click();
  await expect(page.locator('#setup-profile option')).toHaveCount(2);
  expect(await page.evaluate(() => window.switchedNetworks)).toEqual([]);
  await page.locator('#setup-profile').selectOption('friend'); await page.locator('#setup-switch').click();
  await expect.poll(() => page.evaluate(() => window.switchedNetworks)).toEqual(['friend']);
  await page.locator('#setup-close').click();
  await page.locator('#display-name').fill('Network selector'); await page.locator('#party-name').fill('Stay connected');
  await page.locator('#create-party').click(); await expect(page.locator('#room-active')).toBeVisible();
  await page.locator('#network-help').click(); await expect(page.locator('#setup-switch')).toBeDisabled();
  await expect(page.locator('#setup-add-network')).toBeDisabled();
});

test('named parties save locally, reveal authenticated presence, and rejoin after everyone leaves', async ({ browser }) => {
  const hostContext = await browser.newContext(), friendContext = await browser.newContext();
  const host = await hostContext.newPage(), friend = await friendContext.newPage();
  const errors = [];
  for (const page of [host, friend]) {
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.deviceRequests = 0;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { window.deviceRequests++; return getUserMedia(...args); };
    });
  }
  try {
    await host.goto('/'); await host.locator('#display-name').fill('Alex');
    await host.locator('#party-name').fill('Friday movie night'); await host.locator('#create-party').click();
    await expect(host.locator('#room-title')).toHaveText('Friday movie night');
    await expect(host.locator('#saved-parties .party-card')).toHaveCount(1);
    const invite = await host.locator('#room-code').textContent();
    const code = new URL(invite).hash;
    await friend.goto('/'); await friend.locator('#meeting-code').fill(invite);
    await friend.locator('#save-party-invite').click();
    const friendCard = friend.locator('.party-card').filter({ hasText: 'Friday movie night' });
    await expect(friendCard.locator('.party-presence')).toContainText('Alex');
    await friend.locator('#display-name').fill('Jamie'); await friendCard.locator('.party-join').click();
    await expect(friend.locator('#room-active')).toBeVisible();
    await expect(friend.locator('#participants .participant-tile')).toHaveCount(2);
    await expect(host.locator('#saved-parties .party-presence')).toContainText('Jamie');
    await host.locator('#leave-room').click();
    await expect(friend.locator('#room-active')).toBeVisible();
    await expect(friend.locator('#participants .participant-tile')).toHaveCount(1);
    await friend.locator('#leave-room').click();
    await host.reload();
    const hostCard = host.locator('.party-card').filter({ hasText: 'Friday movie night' });
    await expect(hostCard).toBeVisible();
    await expect(hostCard.locator('.party-presence')).toHaveText('No one here yet. Take the first seat.');
    await hostCard.locator('.party-join').click();
    await expect(host.locator('#room-active')).toBeVisible();
    expect(new URL(await host.locator('#room-code').textContent()).hash).toBe(code);
    expect(await host.evaluate(() => window.deviceRequests)).toBe(0);
    expect(await friend.evaluate(() => window.deviceRequests)).toBe(0);
    await expect(host.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(host.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await friendContext.close(); }
});

test('joining a saved party invite automatically adds it to this device’s party library', async ({ browser }) => {
  const host = await browser.newPage(), guest = await browser.newPage();
  try {
    await host.goto('/'); await host.locator('#display-name').fill('Party owner');
    await host.locator('#party-name').fill('Sunday watch club'); await host.locator('#create-party').click();
    await expect(host.locator('#room-active')).toBeVisible();
    await guest.goto('/'); await guest.locator('#display-name').fill('Friend');
    await guest.locator('#meeting-code').fill(await host.locator('#room-code').textContent()); await guest.locator('#join-room').click();
    await expect(guest.locator('#saved-parties .party-card h3')).toHaveText('Sunday watch club');
    await guest.locator('#leave-room').click(); await guest.reload();
    await expect(guest.locator('#saved-parties .party-card h3')).toHaveText('Sunday watch club');
    await guest.locator('.party-remove').click();
    await expect(guest.locator('#saved-parties .party-card')).toHaveCount(0);
    await expect(host.locator('#room-active')).toBeVisible();
  } finally { await host.close(); await guest.close(); }
});

test('private network setup opens sign-in only on request and refreshes into connected status', async ({ page }) => {
  await page.addInitScript(() => {
    let checks = 0, connected = false;
    window.networkConnectCalls = 0; window.networkHelpCalls = 0;
    const status = () => connected
      ? { state: 'connected', installed: true, ip: '100.64.0.11', peers: [{ name: 'Sam-PC', ip: '100.64.0.12', online: true }], message: 'Private network ready.' }
      : { state: 'login-required', installed: true, ip: null, peers: [], message: 'Sign in to connect this PC.' };
    window.togetherDesktop = {
      getInfo: async () => ({ localOrigin: location.origin, lanOrigin: location.origin, internet: { state: 'off', url: null } }),
      getNetworkStatus: async () => { if (++checks > 1) connected = true; return status(); },
      connectNetwork: async () => { window.networkConnectCalls++; return { ...status(), authUrlOpened: true }; },
      openNetworkHelp: async () => { window.networkHelpCalls++; },
      onInvitation() {}, onInternetState() {},
    };
  });
  await page.goto('/'); await expect(page.locator('#network-state')).toHaveText('Sign in to connect your network');
  expect(await page.evaluate(() => window.networkConnectCalls)).toBe(0);
  await page.locator('#connect-network').click(); await expect(page.locator('#status')).toContainText('sign-in page is open');
  expect(await page.evaluate(() => window.networkConnectCalls)).toBe(1);
  await page.locator('#refresh-network').click(); await expect(page.locator('#network-state')).toHaveText('Private network connected');
  await expect(page.locator('#network-peers')).toContainText('Sam-PC');
  await page.locator('#network-help').click(); await expect(page.locator('#connection-setup')).toBeVisible();
  expect(await page.evaluate(() => window.networkHelpCalls)).toBe(0);
  await page.locator('#setup-create-invite').click(); expect(await page.evaluate(() => window.networkHelpCalls)).toBe(1);
  await page.locator('#setup-close').click();
});

test('stream priority is selectable and remains saved without starting any device', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#stream-mode')).toHaveValue('balanced');
  await page.locator('#stream-mode').selectOption('smooth');
  await expect(page.locator('#stream-mode-note')).toContainText('steady frame delivery');
  await page.reload(); await expect(page.locator('#stream-mode')).toHaveValue('smooth');
  await page.locator('#stream-mode').selectOption('source'); await expect(page.locator('#stream-mode-note')).toContainText('preserves your quality targets');
  await expect(page.locator('#toggle-mic')).toBeDisabled(); await expect(page.locator('#toggle-camera')).toBeDisabled();
});

test('connected private-network invites are selected automatically without starting a tunnel', async ({ page }) => {
  await page.addInitScript(() => {
    window.togetherDesktop = {
      getInfo: async () => ({ platform: 'win32', localOrigin: location.origin, lanOrigin: location.origin, privateOrigin: `http://100.64.0.9:${location.port}`, internet: { state: 'off', url: null } }),
      getNetworkStatus: async () => ({ state: 'connected', installed: true, ip: '100.64.0.9', peers: [{ name: 'Friend’s laptop', ip: '100.64.0.10', online: true }], message: 'Connected to your private network.' }),
      connectNetwork: async () => { throw new Error('Already-connected network must not request a login.'); },
      onInvitation() {}, onInternetState() {}, writeClipboard: async text => { window.qaClipboard = text; },
    };
  });
  await page.goto('/'); await page.locator('#display-name').fill('Private host'); await page.locator('#create-room').click();
  await expect(page.locator('#network-state')).toHaveText('Private network connected');
  await expect(page.locator('#room-code')).toContainText('http://100.64.0.9:4399/#code=');
  await expect(page.locator('#reachability-badge')).toHaveText('Private network address');
  await page.locator('#copy-code').click();
  expect(await page.evaluate(() => window.qaClipboard)).toMatch(/^http:\/\/100\.64\.0\.9:4399\/#code=/);
  await expect(page.locator('#network-peers')).toContainText('Friend’s laptop');
  await expect(page.locator('#connect-network')).toBeDisabled();
  await page.locator('#public-address-options summary').click();
  await expect(page.locator('#start-internet')).toBeVisible();
  await page.locator('#reconnect-media').click();
  await expect(page.locator('#status')).toContainText('already connected');
  await page.locator('#leave-room').click();
});

test('a guest shares through the button, viewers follow, and the host can share after they stop', async ({ browser }) => {
  const context = await browser.newContext();
  const host = await context.newPage(), guest = await context.newPage();
  try {
    await host.goto('/'); await host.locator('#display-name').fill('Host'); await host.locator('#create-room').click();
    const code = await host.locator('#room-code').textContent();
    await guest.goto('/'); await guest.locator('#display-name').fill('Guest presenter');
    await guest.locator('#meeting-code').fill(code); await guest.locator('#join-room').click();
    for (const page of [host, guest]) await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let n = 0;
        const timer = setInterval(() => { ctx.fillStyle = `hsl(${n++ % 360} 50% 30%)`; ctx.fillRect(0, 0, 640, 360); }, 16);
        const stream = canvas.captureStream(60); window.qaScreenTracks = stream.getTracks();
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        return stream;
      };
    });
    await guest.locator('#system-audio').uncheck(); await guest.locator('#share-screen').click();
    await expect(guest.locator('#share-screen')).toHaveText('Stop sharing');
    await expect(host.locator('#stage-caption')).toHaveText('Guest presenter is sharing');
    await expect.poll(() => host.locator('#screen-video').evaluate(video => video.currentTime)).toBeGreaterThan(0);
    await expect(host.locator('#share-screen')).toBeDisabled();
    await expect(host.locator('.settings-grid')).toBeHidden();
    await expect(guest.locator('.settings-grid')).toBeVisible();
    await guest.locator('#share-screen').click();
    expect(await guest.evaluate(() => window.qaScreenTracks.every(track => track.readyState === 'ended'))).toBe(true);
    await expect(host.locator('#share-screen')).toBeEnabled();
    await host.locator('#system-audio').uncheck(); await host.locator('#share-screen').click();
    await expect(guest.locator('#stage-caption')).toHaveText('Host is sharing');
    await expect(guest.locator('#share-screen')).toBeDisabled();
    await host.locator('#share-screen').click(); await host.locator('#leave-room').click();
    await expect(guest.locator('#room-entry')).toBeVisible();
  } finally { await context.close(); }
});

test('meeting code joins; cameras, microphones, chat and ending work through the interface', async ({ browser }, info) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();
  const errors = [];
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message));
  await host.goto('/');
  await host.locator('#display-name').fill('Host');
  await host.locator('#create-room').click();
  await expect(host.locator('#room-active')).toBeVisible();
  const code = await host.locator('#room-code').textContent();
  expect(code).toContain('127.0.0.1:4399/');
  await guest.goto('/');
  await guest.locator('#display-name').fill('Friend');
  await guest.locator('#meeting-code').fill(code);
  await guest.locator('#join-room').click();
  await expect(guest.locator('#room-active')).toBeVisible();
  await expect(host.locator('#participants .participant-tile')).toHaveCount(2);
  await expect(guest.locator('#participants .participant-tile')).toHaveCount(2);
  await expect(guest.locator('#share-screen')).toBeEnabled();
  await expect(guest.locator('#fps')).toBeEnabled();
  await expect(guest.locator('.settings-grid')).toBeVisible();
  await expect(host.locator('.settings-grid')).toBeVisible();
  await host.evaluate(() => {
    window.deviceFeedback = [];
    window.addEventListener('together-device-feedback', event => window.deviceFeedback.push(event.detail));
  });
  await guest.evaluate(() => {
    window.deviceFeedback = [];
    window.addEventListener('together-device-feedback', event => window.deviceFeedback.push(event.detail));
  });
  await host.locator('#toggle-camera').click();
  await guest.locator('#toggle-mic').click();
  await expect(host.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'true');
  await expect(guest.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'true');
  expect(await host.evaluate(() => window.deviceFeedback.at(-1).phrase)).toBe('Camera activated');
  expect(await guest.evaluate(() => window.deviceFeedback.at(-1).phrase)).toBe('Microphone activated');
  await guest.locator('#toggle-mic').click();
  await expect(guest.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
  expect(await guest.evaluate(() => window.deviceFeedback.at(-1).phrase)).toBe('Microphone muted');
  await guest.locator('#toggle-mic').click();
  await host.locator('#fullscreen').click();
  await expect.poll(() => host.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await host.locator('#fullscreen').click();
  await expect.poll(() => host.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await expect(host.locator('.participant-tile').filter({ hasText: 'Friend' }).locator('.participant-mic')).toHaveText('Mic on');
  await expect.poll(() => host.locator('.participant-tile').filter({ hasText: 'Friend' }).locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.1);
  await expect(guest.locator('.participant-tile').filter({ hasText: 'Host' }).locator('video')).not.toHaveClass(/camera-off/);
  await guest.locator('#chat-input').fill('Hello from the other seat <script>no()</script>');
  await guest.locator('#chat-form button').click();
  await expect(host.locator('.chat-message p')).toHaveText('Hello from the other seat <script>no()</script>');
  await host.screenshot({ path: info.outputPath('room-desktop.png'), fullPage: true });
  await guest.setViewportSize({ width: 1000, height: 730 });
  expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await guest.screenshot({ path: info.outputPath('room-compact.png'), fullPage: true });
  await host.locator('#leave-room').click();
  await expect(guest.locator('#room-entry')).toBeVisible();
  await expect(guest.locator('#status')).toContainText('host ended');
  expect(errors).toEqual([]);
  await host.close(); await guest.close();
});

test('invalid code is explained; an invite never starts devices automatically', async ({ page }) => {
  await page.goto('/');
  await page.locator('#display-name').fill('Viewer');
  await page.locator('#meeting-code').fill('this is not a code');
  await page.locator('#join-room').click();
  await expect(page.locator('#status')).toContainText('code is incomplete');
  await expect(page.locator('#toggle-camera')).toBeDisabled();
  await page.goto('/#code=ABCDEFGH-abcdefghijkl');
  await expect(page.locator('#meeting-code')).toHaveValue('http://127.0.0.1:4399/#code=ABCDEFGH-abcdefghijkl');
  await expect(page.locator('#room-entry')).toBeVisible();
  await expect(page.locator('#toggle-mic')).toBeDisabled();
  await expect(page.locator('#screen-video')).toBeHidden();
});

test('a clicked meeting-code URL opens the browser join screen without opening devices', async ({ page }) => {
  const code = 'ABCDEFGH-AbCd1234_--x';
  await page.goto(`/${code}`);
  await expect(page.locator('#meeting-code')).toHaveValue(`http://127.0.0.1:4399/#code=${code}`);
  await expect(page.locator('#room-entry')).toBeVisible();
  await expect(page.locator('#toggle-mic')).toBeDisabled();
  await expect(page.locator('#toggle-camera')).toBeDisabled();
  await expect(page.locator('#create-room')).toBeHidden();
  await expect(page.locator('#join-room')).toHaveText('Join this room');
});

test('invites pin the host room and app handoff carries its exact server and code', async ({ browser }) => {
  const host = await browser.newPage();
  const guest = await browser.newPage();
  try {
    await host.goto('/');
    await host.locator('#display-name').fill('Invitation host');
    await host.locator('#create-room').click();
    await expect(host.locator('#room-active')).toBeVisible();
    const copied = await host.locator('#room-code').textContent();
    const code = new URLSearchParams(copied.split('#')[1]).get('code');
    await guest.addInitScript(() => {
      window.launchedAppLinks = [];
      window.addEventListener('together-open-app', event => { event.preventDefault(); window.launchedAppLinks.push(event.detail.uri); });
    });
    await guest.goto(`/?open=app#code=${code}`);
    await expect(guest.locator('#create-room')).toBeHidden();
    await expect(guest.locator('#invitation-title')).toContainText(code.slice(0, 8));
    await expect.poll(() => guest.evaluate(() => window.launchedAppLinks.length)).toBeGreaterThan(0);
    const appLink = new URL(await guest.evaluate(() => window.launchedAppLinks[0]));
    expect(appLink.protocol).toBe('together-watch:');
    expect(appLink.searchParams.get('server')).toBe('http://127.0.0.1:4399');
    expect(appLink.searchParams.get('code')).toBe(code);
    await guest.locator('#display-name').fill('Invited friend');
    await guest.locator('#join-room').click();
    await expect(guest.locator('#room-active')).toBeVisible();
    expect(new URLSearchParams((await guest.locator('#room-code').textContent()).split('#')[1]).get('code')).toBe(code);
    await expect(host.locator('#participants .participant-tile')).toHaveCount(2);
    await expect(guest.locator('#participants .participant-tile')).toHaveCount(2);
  } finally { await host.close(); await guest.close(); }
});

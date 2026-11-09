const { test, expect } = require('@playwright/test');

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
  await expect(guest.locator('#share-screen')).toBeDisabled();
  await expect(guest.locator('#fps')).toBeDisabled();
  await expect(guest.locator('.settings-grid')).toBeHidden();
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

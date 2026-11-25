require('./task-env.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.join(__dirname, '..');
(async () => {
  const env = { ...process.env, TOGETHER_TEST: '1', TOGETHER_TEST_PROFILE: `setup-${Date.now()}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch(process.argv[2] ? { executablePath: path.resolve(process.argv[2]), args: [], env } : { args: [root], env });
  try {
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    await page.locator('#network-help').click();
    await expect(page.locator('#connection-setup')).toBeVisible();
    await expect(page.locator('#setup-state')).not.toHaveText('Checking this PC…');
    await page.screenshot({ path: path.join(root, 'artifacts/setup-desktop.png') });
    expect(await page.evaluate(() => document.querySelector('#connection-setup').scrollWidth <= document.querySelector('#connection-setup').clientWidth + 1)).toBe(true);
    await page.locator('#setup-close').click();
    await expect(page.locator('#toggle-mic')).toBeDisabled();
    if (process.env.TOGETHER_VERIFY_INSTALLER === '1') {
      const result = await app.evaluate(async ({ net }, directory) => {
        const mod = process.mainModule.require(directory + '/desktop/network-install.cjs');
        const installer = mod.createNetworkInstaller({ dataRoot: directory + '/.cache/installer-verification', installed: () => false,
          download: (url, limit) => mod.fetchLimited(url, limit, (url, options) => net.fetch(url, options)), open: async () => {} });
        return installer.install();
      }, root);
      expect(result.state, result.message).toBe('installer-open');
      console.log('Official MSI downloaded on D: and publisher signature verified; installer execution was replaced by a no-op. No installation performed.');
    }
    expect(errors).toEqual([]);
    console.log('Native setup panel passed: actual network status, layout, explicit actions and devices off.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

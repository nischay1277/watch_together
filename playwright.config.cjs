const { cache } = require('./tools/task-env.cjs');
const fs = require('node:fs');
const path = require('node:path');
const localBrowser = path.join(cache, 'ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-win64/chrome-headless-shell.exe');
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.cjs',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4399',
    viewport: { width: 1510, height: 990 },
    headless: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: { executablePath: fs.existsSync(localBrowser) ? localBrowser : undefined, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
    ] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.cjs', url: 'http://127.0.0.1:4399/health',
    env: { PORT: '4399', BIND_HOST: '127.0.0.1' }, reuseExistingServer: false,
  },
});

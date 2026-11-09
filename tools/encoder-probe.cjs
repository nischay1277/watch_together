require('./task-env.cjs');
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const env = { ...process.env, TOGETHER_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    const result = await page.evaluate(async () => {
      const sender = RTCRtpSender.getCapabilities('video');
      const receiver = RTCRtpReceiver.getCapabilities('video');
      const probes = [];
      for (const codec of sender.codecs.filter(codec => !/rtx|red|ulpfec|flexfec/i.test(codec.mimeType))) {
        const contentTypes = [codec.mimeType, codec.mimeType + (codec.sdpFmtpLine ? '; ' + codec.sdpFmtpLine.replaceAll(';', '; ') : '')];
        for (const contentType of new Set(contentTypes)) {
          const config = { type: 'webrtc', video: { contentType, width: 1920, height: 1080, bitrate: 40000000, framerate: 120 } };
          try { probes.push({ contentType, ...await navigator.mediaCapabilities.encodingInfo(config) }); }
          catch (error) { probes.push({ contentType, error: error.message }); }
        }
      }
      return { sender, receiver, probes };
    });
    fs.writeFileSync(path.join(__dirname, '../artifacts/encoder-capabilities.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

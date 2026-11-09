require('./task-env.cjs');
const { _electron: electron, chromium, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const texture = process.env.BENCH_TEXTURE === '1';
const tabCapture = process.env.BENCH_TAB === '1';
const output = path.join(root, `artifacts/browser-window-capture${texture ? '-gpu-texture' : ''}${tabCapture ? '-tab' : ''}.json`);
function remember() {
  const Native = window.RTCPeerConnection; window.qaPeers = [];
  window.RTCPeerConnection = new Proxy(Native, { construct(Target, args) { const pc = Reflect.construct(Target, args); window.qaPeers.push(pc); return pc; } });
}
async function snapshot(host, viewer, source) {
  const rtp = async (page, sending) => page.evaluate(async sending => {
    const reports = await window.qaPeers[0].getStats();
    const row = [...reports.values()].find(row => row.type === (sending ? 'outbound-rtp' : 'inbound-rtp') && row.kind === 'video' && row.mid === '0' && row.active !== false);
    const input = reports.get(row.mediaSourceId);
    return { timestamp: row.timestamp, frames: sending ? row.framesEncoded : row.framesDecoded, sourceFrames: input?.frames, sourceFps: input?.framesPerSecond, width: row.frameWidth, height: row.frameHeight, codec: reports.get(row.codecId)?.mimeType, implementation: row.encoderImplementation, limitation: row.qualityLimitationReason };
  }, sending);
  const [send, receive, playback] = await Promise.all([rtp(host, true), rtp(viewer, false), source.evaluate(() => {
    const video = document.querySelector('video'); const quality = video.getVideoPlaybackQuality();
    return { timestamp: performance.now(), total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames, currentTime: video.currentTime, visibility: document.visibilityState, size: [video.videoWidth, video.videoHeight] };
  })]);
  return { send, receive, playback };
}
(async () => {
  let app, sourceBrowser, viewerBrowser;
  const report = { source: 'A generated 60 FPS video in a separate Chromium window, never user apps or a user screen.', phases: [] };
  try {
    const env = { ...process.env, TOGETHER_TEST: '1' }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [...(texture ? ['--enable-features=WebRtcAllowWgcUsingTexture'] : []), root], env });
    let host = await app.firstWindow();
    await expect(host.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    await host.evaluate(remember);
    const origin = new URL(host.url()).origin;
    await host.locator('#display-name').fill('Browser capture test host');
    await host.locator('#fps').selectOption('240');
    await host.locator('#resolution').selectOption('0');
    await host.locator('#bitrate').selectOption('0');
    await host.locator('#create-room').click();
    await expect(host.locator('#room-active')).toBeVisible();
    sourceBrowser = await chromium.launch({ headless: false,
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
      args: ['--window-size=1536,864', '--window-position=0,0', ...(tabCapture ? ['--auto-select-tab-capture-source-by-title=Browser playback QA fixture'] : [])] });
    const sourceContext = await sourceBrowser.newContext({ viewport: null });
    const source = await sourceContext.newPage();
    await source.setContent('<title>Browser playback QA fixture</title><style>body{margin:0;background:#18221a;color:white}video{width:100vw;height:100vh;object-fit:contain}canvas{display:none}</style><button>Generate private test video</button><canvas width="1920" height="1080"></canvas><video muted loop playsinline></video>');
    if (fs.existsSync(path.join(root, 'artifacts/browser-source-60fps.webm'))) {
      await source.evaluate(async data => {
        const video = document.querySelector('video');
        video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'video/webm' }));
        await video.play(); window.qaVideoReady = true; window.qaSourceMime = 'Fixed VP9 WebM, 240 frames / 4 seconds';
        document.querySelector('button').remove();
      }, fs.readFileSync(path.join(root, 'artifacts/browser-source-60fps.webm')).toString('base64'));
    } else {
    await source.evaluate(() => {
      document.querySelector('button').onclick = async () => {
        const canvas = document.querySelector('canvas'); const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(60);
        const mime = ['video/mp4;codecs=avc1.64002A', 'video/webm;codecs=vp8'].find(mime => MediaRecorder.isTypeSupported(mime));
        const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
        const chunks = []; let n = 0;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          clearInterval(timer); stream.getTracks().forEach(track => track.stop());
          const video = document.querySelector('video'); video.src = URL.createObjectURL(new Blob(chunks, { type: mime }));
          await video.play(); window.qaVideoReady = true; window.qaSourceMime = mime;
          document.querySelector('button').remove();
        };
        const timer = setInterval(() => {
          ctx.fillStyle = `hsl(${n++ % 360} 60% 22%)`; ctx.fillRect(0, 0, 1920, 1080);
          ctx.fillStyle = '#d5ee9f';
          for (let i = 0; i < 20; i++) ctx.fillRect((n * 15 + i * 173) % 1920, 40 + i * 49, 120, 35);
          ctx.font = '48px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(`Generated video · ${n}`, 50, 70);
        }, 1000 / 60);
        recorder.start(); setTimeout(() => recorder.stop(), 6000);
      };
    });
    await source.locator('button').click();
    }
    await expect.poll(() => source.evaluate(() => window.qaVideoReady), { timeout: 20000 }).toBe(true);
    report.sourceMime = await source.evaluate(() => window.qaSourceMime);
    if (tabCapture) {
      await host.locator('#leave-room').click();
      host = await sourceContext.newPage(); await host.goto(origin); await host.evaluate(remember);
      await host.locator('#display-name').fill('Private browser tab host');
      await host.locator('#fps').selectOption('240'); await host.locator('#resolution').selectOption('0');
      await host.locator('#bitrate').selectOption('0'); await host.locator('#create-room').click();
      await expect(host.locator('#room-active')).toBeVisible();
    }
    await host.locator('#system-audio').uncheck();
    await host.locator('#share-screen').click();
    if (!tabCapture) {
      await host.locator('#source-window-tab').click();
      await host.locator('#source-list button').filter({ hasText: 'Browser playback QA fixture' }).click();
    }
    await expect(host.locator('#share-screen')).toHaveText('Stop sharing');
    report.capture = await host.locator('#screen-video').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings());
    if (tabCapture) expect(report.capture.displaySurface).toBe('browser');
    viewerBrowser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const viewer = await viewerBrowser.newPage(); await viewer.addInitScript(remember);
    await viewer.goto(origin); await viewer.locator('#display-name').fill('Browser test viewer');
    const code = new URLSearchParams((await host.locator('#room-code').textContent()).split('#')[1]).get('code');
    await viewer.locator('#meeting-code').fill(`${origin}/#code=${code}`); await viewer.locator('#join-room').click();
    await expect.poll(() => viewer.locator('#screen-video').evaluate(video => video.currentTime), { timeout: 20000 }).toBeGreaterThan(0);
    for (const covered of [false, true]) {
      if (covered) {
        await app.evaluate(async ({ BrowserWindow }) => {
          const cover = new BrowserWindow({ width: 1536, height: 864, title: 'Together private occlusion fixture', show: true, webPreferences: { sandbox: true, nodeIntegration: false } });
          globalThis.qaCoverWindow = cover;
          await cover.loadURL('data:text/html,<title>Together private occlusion fixture</title><body style="background:%2318211a;color:white;font:40px sans-serif">Private occlusion test</body>');
          cover.maximize(); cover.show(); cover.focus();
        });
      } else {
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:')).minimize());
        await source.bringToFront();
      }
      await viewer.waitForTimeout(6000);
      const start = await snapshot(host, viewer, source);
      await viewer.waitForTimeout(8000);
      const end = await snapshot(host, viewer, source);
      const fps = (a, b, frames = 'frames') => (b[frames] - a[frames]) * 1000 / (b.timestamp - a.timestamp);
      const phase = { covered, playbackFps: fps(start.playback, end.playback, 'total'), playbackDropped: end.playback.dropped - start.playback.dropped,
        encodedFps: fps(start.send, end.send), decodedFps: fps(start.receive, end.receive), reportedCaptureFps: end.send.sourceFps,
        final: end, diagnostics: await host.locator('#media-diagnostics').textContent() };
      report.phases.push(phase); console.log(JSON.stringify(phase));
    }
    report.completed = true;
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    await viewerBrowser?.close().catch(() => {}); await sourceBrowser?.close().catch(() => {}); await app?.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

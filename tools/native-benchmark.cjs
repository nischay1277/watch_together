require('./task-env.cjs');
const { _electron: electron, chromium, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');

const projectPath = path.join(__dirname, '..');
const requestedFps = Number(process.env.BENCH_FPS) || 120;
if (![60, 120, 144, 165, 240].includes(requestedFps)) throw new Error('Choose a supported BENCH_FPS target.');
const fullDisplayFixture = process.env.BENCH_FULL_DISPLAY === '1';
const warmupSeconds = Math.max(0, Math.min(60, Number(process.env.TOGETHER_BENCHMARK_WARMUP_SEC) || 15));
const codecInput = String(process.env.BENCH_CODEC || 'auto').toLowerCase().replace('video/', '');
const requestedCodec = ({ auto: 'auto', vp9: 'video/VP9', h264: 'video/H264', av1: 'video/AV1' })[codecInput];
if (!requestedCodec) throw new Error('BENCH_CODEC must be auto, vp9, h264, or av1.');
const degradationOverride = process.env.BENCH_DEGRADATION || '';
const forceCodec = process.env.BENCH_FORCE_CODEC || '';
const reportSuffix = (process.env.BENCH_CODEC || degradationOverride
  ? `-${codecInput}${degradationOverride ? '-fixed-resolution' : ''}` : '') + (fullDisplayFixture ? '-native-display-size' : '') + (forceCodec ? '-forced' : '') + (process.env.BENCH_FPS ? `-${requestedFps}fps` : '');
const outputPath = path.join(__dirname, `../artifacts/native-webrtc-benchmark${reportSuffix}.json`);

function rememberConnections() {
  const Native = window.RTCPeerConnection;
  window.__benchmarkPeers = [];
  window.RTCPeerConnection = new Proxy(Native, {
    construct(Target, args) {
      const connection = Reflect.construct(Target, args);
      window.__benchmarkPeers.push(connection);
      return connection;
    },
  });
}

async function readRtp(page, direction) {
  return page.evaluate(async (way) => {
    const matches = [];
    for (const connection of window.__benchmarkPeers) {
      const reports = await connection.getStats();
      let selectedPair;
      reports.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) selectedPair = reports.get(report.selectedCandidatePairId);
      });
      reports.forEach(report => {
        if (report.type !== (way === 'sending' ? 'outbound-rtp' : 'inbound-rtp')) return;
        if ((report.kind || report.mediaType) !== 'video' || report.mid !== '0' || report.isRemote) return;
        matches.push({
          id: report.id,
          timestamp: report.timestamp,
          frames: way === 'sending' ? report.framesEncoded : report.framesDecoded,
          bytes: way === 'sending' ? report.bytesSent : report.bytesReceived,
          width: report.frameWidth,
          height: report.frameHeight,
          reportedFramesPerSecond: report.framesPerSecond,
          qualityLimitationReason: report.qualityLimitationReason || null,
          codec: reports.get(report.codecId)?.mimeType || null,
          sourceFps: reports.get(report.mediaSourceId)?.framesPerSecond ?? null,
          implementation: way === 'sending' ? report.encoderImplementation : report.decoderImplementation,
          availableOutgoingBitrate: selectedPair?.availableOutgoingBitrate || null,
          currentRoundTripTime: selectedPair?.currentRoundTripTime ?? null,
          connectionState: connection.connectionState,
        });
      });
    }
    if (matches.length !== 1) throw new Error(`Expected one screen RTP stream, found ${matches.length}.`);
    return matches[0];
  }, direction);
}

function measurement(previous, current) {
  const seconds = (current.timestamp - previous.timestamp) / 1000;
  if (!(seconds > 0)) throw new Error('RTP statistics did not advance.');
  return {
    seconds,
    frames: current.frames - previous.frames,
    fps: (current.frames - previous.frames) / seconds,
    mbps: (current.bytes - previous.bytes) * 8 / seconds / 1e6,
    width: current.width,
    height: current.height,
    reportedFramesPerSecond: current.reportedFramesPerSecond,
    qualityLimitationReason: current.qualityLimitationReason,
    codec: current.codec,
    sourceFps: current.sourceFps,
    implementation: current.implementation,
    availableOutgoingBitrate: current.availableOutgoingBitrate,
    currentRoundTripTime: current.currentRoundTripTime,
  };
}

function summarize(samples) {
  const seconds = samples.reduce((sum, sample) => sum + sample.seconds, 0);
  const frames = samples.reduce((sum, sample) => sum + sample.frames, 0);
  return {
    averageFps: seconds ? frames / seconds : null,
    maxFps: samples.length ? Math.max(...samples.map(sample => sample.fps)) : null,
    minFps: samples.length ? Math.min(...samples.map(sample => sample.fps)) : null,
    measuredSeconds: seconds,
    measuredFrames: frames,
    actualEncodedOrDecodedResolutions: [...new Set(samples.map(sample => `${sample.width}x${sample.height}`))],
    qualityLimitationReasons: [...new Set(samples.map(sample => sample.qualityLimitationReason).filter(Boolean))],
    samples,
  };
}

(async () => {
  const env = { ...process.env, TOGETHER_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, browser, guestContext;
  const errors = [];
  const report = {
    createdAt: new Date().toISOString(),
    kind: 'Real Windows window capture through the app source picker, encoded over WebRTC and decoded in Chromium',
    source: 'A dedicated animated BrowserWindow only. No user desktop/apps, real microphone, or camera is captured.',
    requestedFps,
    requestedResolution: fullDisplayFixture ? 0 : 720,
    requestedBitrateMbps: fullDisplayFixture ? 0 : 25,
    requestedCodec,
    requestedDegradationPreference: degradationOverride || 'maintain-framerate-and-resolution',
    warmupSeconds,
    systemAudio: false,
    notes: 'This measures changing pixels in a real native window. It does not establish performance for every browser, video service, resolution, display, or network.',
  };
  try {
    app = await electron.launch({ args: [projectPath], env });
    const host = await app.firstWindow();
    await expect(host.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    // Instrument before a room creates connections. Never reload the native
    // host: firstWindow can resolve before main-process loadURL completes.
    await host.evaluate(rememberConnections);
    host.on('pageerror', error => errors.push(`host: ${error.message}`));
    await expect(host.locator('#platform-label')).toHaveText('WINDOWS DESKTOP');
    const origin = new URL(host.url()).origin;
    await expect(host.locator('#server-url')).toHaveValue(origin);
    await host.locator('#display-name').fill('Native benchmark host');
    await host.locator('#fps').selectOption(String(requestedFps));
    await host.locator('#resolution').selectOption(fullDisplayFixture ? '0' : '720');
    await host.locator('#bitrate').selectOption(fullDisplayFixture ? '0' : '25');
    await host.locator('#codec').selectOption(requestedCodec);
    await host.locator('#create-room').click();
    await expect(host.locator('#room-active')).toBeVisible();
    await expect(host.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(host.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');

    report.displayContext = await app.evaluate(async ({ app: nativeApp, BrowserWindow, screen }, fullSize) => {
      const display = screen.getPrimaryDisplay();
      const probe = new BrowserWindow({
        width: 960, height: 600,
        x: display.workArea.x + 40, y: display.workArea.y + 40,
        title: 'Capture benchmark pattern', show: true, skipTaskbar: true,
        ...(fullSize ? { ...display.bounds, frame: false, fullscreen: true } : {}),
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
      });
      const html = `<!doctype html><html><head><title>Capture benchmark pattern</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#18231b}canvas{display:block;width:100vw;height:100vh}</style></head><body><canvas></canvas><script>
        const canvas=document.querySelector('canvas');
        canvas.width=window.innerWidth*devicePixelRatio;canvas.height=window.innerHeight*devicePixelRatio;
        const context=canvas.getContext('2d');
        context.scale(canvas.width/960,canvas.height/560);
        window.framesDrawn=0;window.drawStarted=performance.now();
        function draw(){const n=window.framesDrawn++;context.fillStyle='hsl('+(n%360)+' 55% 18%)';context.fillRect(0,0,960,560);context.fillStyle='#d5ee9f';for(let i=0;i<8;i++)context.fillRect((n*11+i*127)%960,80+i*45,70,32);context.font='26px sans-serif';context.fillStyle='#fff';context.fillText('Native window capture benchmark · '+n,20,42)}
        draw();window.drawTimer=setInterval(draw,8);
      </script></body></html>`;
      await probe.loadURL('data:text/html,' + encodeURIComponent(html));
      globalThis.__togetherBenchmarkWindow = probe;
      const actual = screen.getDisplayMatching(probe.getBounds());
      return {
        windowBounds: probe.getBounds(), contentBounds: probe.getContentBounds(),
        displayBounds: actual.bounds, scaleFactor: actual.scaleFactor,
        displayFrequencyHz: actual.displayFrequency,
        gpuFeatureStatus: nativeApp.getGPUFeatureStatus(),
        electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome,
      };
    }, fullDisplayFixture);

    await host.locator('#system-audio').uncheck();
    await host.locator('#share-screen').click();
    await expect(host.locator('#source-dialog')).toBeVisible();
    await host.locator('#source-window-tab').click();
    const pattern = host.locator('#source-list button').filter({ hasText: 'Capture benchmark pattern' });
    await expect(pattern).toHaveCount(1);
    await pattern.click();
    await expect(host.locator('#share-screen')).toHaveText('Stop sharing', { timeout: 20000 });
    report.captureSettings = await host.locator('#screen-video').evaluate(video => {
      const stream = video.srcObject;
      return { ...stream.getVideoTracks()[0].getSettings(), audioTrackCount: stream.getAudioTracks().length };
    });
    expect(report.captureSettings.audioTrackCount).toBe(0);

    browser = await chromium.launch({ headless: true, args: [
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required',
    ] });
    guestContext = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const guest = await guestContext.newPage();
    await guest.addInitScript(rememberConnections);
    guest.on('pageerror', error => errors.push(`guest: ${error.message}`));
    await guest.goto(origin);
    await expect(guest.locator('#platform-label')).toHaveText('BROWSER EDITION');
    const portableCode = await host.locator('#room-code').innerText();
    const code = portableCode.includes('#code=') ? new URLSearchParams(portableCode.split('#')[1]).get('code') : portableCode.slice(portableCode.lastIndexOf('/') + 1);
    await guest.locator('#display-name').fill('Native benchmark viewer');
    await guest.locator('#meeting-code').fill(`${origin}/${code}`);
    await guest.locator('#join-room').click();
    await expect(guest.locator('#room-active')).toBeVisible();
    await expect(guest.locator('#toggle-camera')).toHaveAttribute('aria-pressed', 'false');
    await expect(guest.locator('#toggle-mic')).toHaveAttribute('aria-pressed', 'false');
    await expect(guest.locator('#screen-video')).toBeVisible();
    await expect.poll(() => guest.locator('#screen-video').evaluate(video => video.currentTime), { timeout: 20000 }).toBeGreaterThan(0);
    if (forceCodec) {
      report.forcedCodec = await host.evaluate(async mime => {
        const sender = window.__benchmarkPeers[0].getTransceivers()[0].sender;
        const parameters = sender.getParameters();
        const candidates = parameters.codecs.filter(codec => codec.mimeType.toLowerCase() === mime.toLowerCase());
        const rank = codec => /packetization-mode=0/.test(codec.sdpFmtpLine || '') ? -1 : /profile-level-id=6400/.test(codec.sdpFmtpLine || '') ? 3 : /profile-level-id=4d00/.test(codec.sdpFmtpLine || '') ? 2 : 1;
        candidates.sort((a, b) => rank(b) - rank(a));
        const chosen = candidates[0];
        if (!chosen) return { error: 'Not negotiated', negotiated: parameters.codecs };
        for (const encoding of parameters.encodings) encoding.codec = { mimeType: chosen.mimeType, clockRate: chosen.clockRate, sdpFmtpLine: chosen.sdpFmtpLine };
        try { await sender.setParameters(parameters); return { chosen, encodings: sender.getParameters().encodings }; }
        catch (error) { return { chosen, error: error.message }; }
      }, forceCodec);
    }
    if (degradationOverride) {
      report.degradationOverride = await host.evaluate(async preference => {
        const sender = window.__benchmarkPeers[0].getTransceivers()[0].sender;
        const parameters = sender.getParameters();
        parameters.degradationPreference = preference;
        try {
          await sender.setParameters(parameters);
          return { accepted: true, applied: sender.getParameters().degradationPreference };
        } catch (error) {
          return { accepted: false, error: error.message, name: error.name };
        }
      }, degradationOverride);
    }
    await guest.waitForTimeout(warmupSeconds * 1000);

    const sendSamples = [], receiveSamples = [];
    let previousSend = await readRtp(host, 'sending');
    let previousReceive = await readRtp(guest, 'receiving');
    for (let index = 0; index < 8; index++) {
      await guest.waitForTimeout(1000);
      const [send, receive] = await Promise.all([readRtp(host, 'sending'), readRtp(guest, 'receiving')]);
      sendSamples.push(measurement(previousSend, send));
      receiveSamples.push(measurement(previousReceive, receive));
      previousSend = send;
      previousReceive = receive;
    }
    report.hostEncoded = summarize(sendSamples);
    report.guestDecoded = summarize(receiveSamples);
    report.encoderParameters = await host.evaluate(() => {
      const parameters = window.__benchmarkPeers[0].getTransceivers()[0].sender.getParameters();
      return { encodings: parameters.encodings, degradationPreference: parameters.degradationPreference };
    });
    report.videoHealth = await host.locator('#video-health').innerText();
    report.connectionDetails = await host.locator('#media-diagnostics').textContent();
    expect(report.connectionDetails).toContain('Capture input');
    expect(report.connectionDetails).toContain('Codec');
    report.sourceAnimation = await app.evaluate(async () => globalThis.__togetherBenchmarkWindow.webContents.executeJavaScript(`({framesDrawn:window.framesDrawn,elapsedSeconds:(performance.now()-window.drawStarted)/1000,canvasWidth:document.querySelector('canvas').width,canvasHeight:document.querySelector('canvas').height,drawingIntervalMs:8})`));
    report.errors = errors;
    expect(report.hostEncoded.measuredFrames).toBeGreaterThan(0);
    expect(report.guestDecoded.measuredFrames).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await host.locator('#share-screen').click();
    await expect(host.locator('#screen-video')).toBeHidden();
    await guest.locator('#leave-room').click();
    await host.locator('#leave-room').click();
    report.completed = true;
    console.log(JSON.stringify({
      requestedFps, requestedCodec, degradationOverride: report.degradationOverride, captureSettings: report.captureSettings,
      forcedCodec: report.forcedCodec,
      displayFrequencyHz: report.displayContext.displayFrequencyHz,
      hostEncodedAverageFps: report.hostEncoded.averageFps, hostEncodedMaxFps: report.hostEncoded.maxFps,
      guestDecodedAverageFps: report.guestDecoded.averageFps, guestDecodedMaxFps: report.guestDecoded.maxFps,
      encodedResolutions: report.hostEncoded.actualEncodedOrDecodedResolutions,
      decodedResolutions: report.guestDecoded.actualEncodedOrDecodedResolutions,
      videoHealth: report.videoHealth, connectionDetails: report.connectionDetails,
      outputPath,
    }, null, 2));
  } catch (error) {
    report.completed = false;
    report.error = error.stack || error.message;
    report.errors = errors;
    throw error;
  } finally {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    await guestContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await app?.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

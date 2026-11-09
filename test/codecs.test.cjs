const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/engine.js')).toString('base64'));
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 };
const h264Software = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' };
const h264Hardware = { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' };

test('automatic mode selects the accelerated negotiated profile at the actual capture size', async () => {
  const { chooseScreenCodec } = await modulePromise;
  const configurations = [];
  const selected = await chooseScreenCodec([vp8, h264Software, h264Hardware], {
    width: 3840, height: 2160, fps: 240,
    probe: async configuration => {
      configurations.push(configuration);
      return { supported: true, smooth: true, powerEfficient: configuration.video.contentType.includes('4d001f') };
    },
  });
  assert.equal(selected, h264Hardware);
  assert.ok(configurations.every(configuration => configuration.video.width === 3840 && configuration.video.height === 2160 && configuration.video.framerate === 240));
});

test('automatic mode retains the browser codec when acceleration is absent or probing fails', async () => {
  const { chooseScreenCodec } = await modulePromise;
  assert.equal(await chooseScreenCodec([vp8, h264Hardware], { probe: async () => ({ supported: true, smooth: true, powerEfficient: false }) }), null);
  assert.equal(await chooseScreenCodec([vp8], { probe: async () => { throw new Error('Unsupported API'); } }), null);
  assert.equal(await chooseScreenCodec([vp8]), null);
});

test('manual codec selection cannot choose a codec absent from the negotiated list', async () => {
  const { chooseScreenCodec } = await modulePromise;
  assert.equal(await chooseScreenCodec([vp8], { preference: 'video/H264' }), null);
  assert.equal(await chooseScreenCodec([vp8, h264Hardware], { preference: 'video/H264' }), h264Hardware);
});

test('capability hints are cached per capture configuration and invalidated by a new FPS target', async () => {
  const { chooseScreenCodec } = await modulePromise;
  const cache = new Map(); let calls = 0;
  const probe = async () => { calls++; return { supported: true, powerEfficient: true, smooth: true }; };
  await chooseScreenCodec([h264Hardware], { cache, probe, fps: 120 });
  await chooseScreenCodec([h264Hardware], { cache, probe, fps: 120 });
  assert.equal(calls, 1);
  await chooseScreenCodec([h264Hardware], { cache, probe, fps: 240 });
  assert.equal(calls, 2);
});

test('older sender APIs keep their quality parameters when explicit codec selection is rejected', async () => {
  const { MeetingEngine } = await modulePromise;
  const events = [];
  const engine = new MeetingEngine({ settings: { codec: 'video/H264' }, onEvent: (type, data) => events.push({ type, data }) });
  const parameters = { codecs: [vp8, h264Hardware], encodings: [{ maxFramerate: 120, maxBitrate: 40000000 }] };
  let calls = 0;
  const sender = {
    track: { getSettings: () => ({ width: 1920, height: 1080 }) },
    getParameters: () => structuredClone(parameters),
    setParameters: async () => { calls++; throw new DOMException('Codec selection unsupported', 'OperationError'); },
  };
  const peer = { pc: { signalingState: 'stable' } };
  await engine._applyScreenCodec(peer, sender);
  await engine._applyScreenCodec(peer, sender);
  assert.equal(calls, 1);
  assert.equal(peer.legacyCodecSelection, true);
  assert.equal(parameters.encodings[0].maxFramerate, 120);
  assert.equal(parameters.encodings[0].maxBitrate, 40000000);
  assert.equal(events[0].data.state, 'codec-selection-fallback');
});

test('startup bitrate applies only to the screen codecs and adds no forced minimum', async () => {
  const { seedScreenBitrate } = await modulePromise;
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=mid:0\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 H264/90000\r\na=fmtp:98 profile-level-id=4d001f;packetization-mode=1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:2\r\na=rtpmap:96 VP8/90000\r\n';
  const seeded = seedScreenBitrate(sdp, 8000);
  assert.match(seeded, /a=fmtp:96 x-google-start-bitrate=8000/);
  assert.match(seeded, /a=fmtp:98 profile-level-id=4d001f;packetization-mode=1;x-google-start-bitrate=8000/);
  assert.equal(seeded.split('x-google-start-bitrate=').length - 1, 2);
  assert.equal(seeded.split('a=mid:2')[1], sdp.split('a=mid:2')[1]);
  assert.doesNotMatch(seeded, /x-google-min-bitrate|x-google-max-bitrate/);
  assert.equal(seedScreenBitrate(seeded, 8000), seeded);
});

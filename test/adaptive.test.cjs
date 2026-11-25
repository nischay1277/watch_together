const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engineModule = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/engine.js')).toString('base64'));

test('a weak viewer scales independently and smooth mode keeps 60 FPS where possible', async () => {
  const { adaptiveProfile, normalizeSettings } = await engineModule;
  const settings = normalizeSettings({ fps: 60, bitrate: 0, mode: 'smooth' });
  const capture = { width: 1920, height: 1080, frameRate: 60 };
  let weak = {}, fast = {};
  for (let i = 0; i < 6; i++) {
    weak = adaptiveProfile(settings, capture, { availableMbps: 3, limitation: 'bandwidth' }, weak);
    fast = adaptiveProfile(settings, capture, { availableMbps: 40, limitation: 'none' }, fast);
  }
  assert.equal(weak.height, 540); assert.equal(weak.fps, 60);
  assert.equal(fast.scale, 1); assert.equal(fast.height, 1080);
  assert.deepEqual(capture, { width: 1920, height: 1080, frameRate: 60 });
});

test('adaptation ignores short spikes and restores quality only after sustained recovery', async () => {
  const { adaptiveProfile, normalizeSettings } = await engineModule;
  const settings = normalizeSettings({ fps: 60, mode: 'smooth' });
  const capture = { width: 1920, height: 1080, frameRate: 60 };
  let state = {};
  for (let i = 0; i < 2; i++) state = adaptiveProfile(settings, capture, { availableMbps: 1 }, state);
  assert.equal(state.level, 0);
  state = adaptiveProfile(settings, capture, { availableMbps: 1 }, state);
  assert.equal(state.level, 1);
  for (let i = 0; i < 14; i++) state = adaptiveProfile(settings, capture, { availableMbps: 40, limitation: 'none' }, state);
  assert.equal(state.level, 1);
  state = adaptiveProfile(settings, capture, { availableMbps: 40, limitation: 'none' }, state);
  assert.equal(state.level, 0);
});

test('manual bitrate limits are obeyed and source mode never silently scales', async () => {
  const { adaptiveProfile, normalizeSettings } = await engineModule;
  const capture = { width: 3840, height: 2160, frameRate: 60 };
  const source = adaptiveProfile(normalizeSettings({ fps: 120, bitrate: 4, mode: 'source' }), capture, { availableMbps: .4, limitation: 'bandwidth' }, { level: 4 });
  assert.equal(source.scale, 1); assert.equal(source.fps, 60); assert.equal(source.maxBitrate, 4e6);
  let state = {};
  const smooth = normalizeSettings({ fps: 60, bitrate: 1, mode: 'smooth' });
  for (let i = 0; i < 25; i++) state = adaptiveProfile(smooth, capture, {}, state);
  assert.ok(state.maxBitrate <= 1e6); assert.ok(state.height < 2160);
});

test('small captures are never enlarged and missing statistics cannot invent congestion', async () => {
  const { adaptiveProfile, normalizeSettings } = await engineModule;
  const settings = normalizeSettings({ fps: 120, mode: 'smooth' });
  let state = {};
  for (let i = 0; i < 20; i++) state = adaptiveProfile(settings, { width: 640, height: 360, frameRate: 30 }, {}, state);
  assert.equal(state.scale, 1); assert.equal(state.level, 0); assert.equal(state.fps, 30);
});

test('encoder settings use per-viewer adaptation without changing the capture or audio sender', async () => {
  const { MeetingEngine, normalizeSettings } = await engineModule;
  const engine = new MeetingEngine({ settings: { fps: 60, mode: 'smooth', bitrate: 4 } });
  const applied = [];
  const track = { getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }) };
  const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: async p => applied.push(p) };
  const peer = { pc: { remoteDescription: {}, signalingState: 'stable' }, transceivers: [{ sender }], adaptation: { fps: 60, scale: 1.5, maxBitrate: 3000000, level: 1 } };
  engine._applyScreenCodec = async () => {};
  await engine._applySenders(peer);
  assert.equal(applied[0].encodings[0].scaleResolutionDownBy, 1.5);
  assert.equal(applied[0].encodings[0].maxFramerate, 60);
  assert.equal(applied[0].encodings[0].maxBitrate, 3000000);
  assert.equal(applied[0].degradationPreference, 'maintain-framerate');
  engine.settings = normalizeSettings({ fps: 60, mode: 'source', bitrate: 8 });
  peer.adaptation = null;
  await engine._applySenders(peer);
  assert.equal(applied[1].encodings[0].scaleResolutionDownBy, 1);
  assert.equal(applied[1].encodings[0].maxBitrate, 8000000);
  engine.close();
});

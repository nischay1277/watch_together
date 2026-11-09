const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engineModule = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/engine.js')).toString('base64'));

async function fixture({ receiving = false } = {}) {
  const { MeetingEngine } = await engineModule;
  const events = [];
  const engine = new MeetingEngine({ onEvent: (type, data) => events.push({ type, data }) });
  engine.role = receiving ? 'guest' : 'host';
  engine.selfId = receiving ? 'viewer' : 'host';
  engine.hostId = 'host';
  engine.members = [{ id: 'host', name: 'Host', media: { screen: true } }];
  if (!receiving) engine.screenStream = { getTracks: () => [{ kind: 'video', readyState: 'live', id: 'screen-track', getSettings: () => ({ width: 1920, height: 1080 }) }] };
  const collect = async () => {
    await engine._collectStats();
    assert.equal(events.at(-1)?.type, 'stats', 'collection must emit usable telemetry');
    return events.at(-1).data;
  };
  const addPeer = (id, { state = 'connected', fps = 120, sourceFps = 120, receivedFps = fps, inactive = false } = {}) => {
    let tick = 1;
    const rtp = () => ({
      id: `${id}-video`, type: receiving ? 'inbound-rtp' : 'outbound-rtp', kind: 'video', mid: '0',
      timestamp: tick * 1000, framesEncoded: tick * fps, framesDecoded: tick * fps,
      framesSent: tick * fps, framesReceived: tick * receivedFps, bytesSent: tick * 1000000, bytesReceived: tick * 1000000,
      framesPerSecond: fps, frameWidth: 1920, frameHeight: 1080,
      mediaSourceId: 'source', codecId: 'codec', encoderImplementation: 'test-encoder', decoderImplementation: 'test-decoder',
      totalEncodeTime: tick * fps * .002, totalDecodeTime: tick * fps * .003, qualityLimitationReason: 'none',
    });
    const reports = () => new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', currentRoundTripTime: .05, availableOutgoingBitrate: 20000000, localCandidateId: 'local' }],
      ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp' }],
      ['source', { type: 'media-source', kind: 'video', trackIdentifier: 'screen-track', timestamp: tick * 1000, frames: tick * sourceFps, framesPerSecond: sourceFps }],
      ['codec', { type: 'codec', mimeType: 'video/H264' }],
    ]);
    const slotStats = async () => {
      const rows = reports();
      rows.set(`${id}-video`, rtp());
      if (inactive) rows.set('old-video', { ...rtp(), id: 'old-video', active: false, framesPerSecond: 0, framesEncoded: 0, framesDecoded: 0 });
      return rows;
    };
    const peer = {
      id, pc: { connectionState: state, iceConnectionState: state, getStats: async () => { assert.equal(peer.pc.connectionState, 'connected', 'must not read stale reports from failed peers'); return reports(); } },
      transceivers: [{ mid: '0', sender: { getStats: slotStats }, receiver: { getStats: slotStats } }],
    };
    engine._peers.set(id, peer);
    if (id !== 'host') engine.members.push({ id, name: id, media: {} });
    return { peer, advance: () => tick++ };
  };
  return { engine, collect, addPeer };
}

test('failed peers and inactive RTP reports cannot zero a healthy screen stream', async () => {
  const f = await fixture();
  const healthy = f.addPeer('healthy', { inactive: true });
  f.addPeer('failed', { state: 'failed', fps: 0 });
  await f.collect(); healthy.advance();
  const stats = await f.collect();
  assert.equal(stats.fps, 120);
  assert.equal(stats.peers, 1);
  assert.equal(stats.failedPeers, 1);
  assert.equal(stats.videoState, 'active');
  assert.equal(stats.rtt, 50);
  assert.equal(stats.peerStats.find(peer => peer.id === 'failed').fps, null);
});

test('a failed media path is unavailable, rather than measured zero FPS with stale RTT', async () => {
  const f = await fixture();
  f.addPeer('failed', { state: 'failed', fps: 0 });
  const stats = await f.collect();
  assert.equal(stats.fps, null);
  assert.equal(stats.rtt, null);
  assert.equal(stats.bitrate, null);
  assert.equal(stats.videoState, 'media-unavailable');
  assert.equal(stats.turnConfigured, false);
  f.engine._iceServers = [{ urls: ['stun:test.invalid', 'turn:test.invalid'] }];
  assert.equal((await f.collect()).turnConfigured, true);
});

test('capture rate and encoder rate stay distinct, with actual codec and frame cost', async () => {
  const f = await fixture();
  const healthy = f.addPeer('viewer', { fps: 9, sourceFps: 60 });
  await f.collect(); healthy.advance();
  const stats = await f.collect();
  assert.equal(stats.sourceFps, 60);
  assert.equal(stats.fps, 9);
  assert.equal(stats.peerStats[0].sentFps, 9);
  assert.equal(stats.peerStats[0].codec, 'H264');
  assert.ok(Math.abs(stats.peerStats[0].encodeMs - 2) < .000001);
  assert.equal(stats.peerStats[0].route, 'direct UDP');
  assert.equal(stats.resolution, '1920 × 1080');
});

test('arriving frames with no decode progress identify a viewer decode stall', async () => {
  const f = await fixture({ receiving: true });
  const host = f.addPeer('host', { fps: 0, receivedFps: 60 });
  await f.collect(); host.advance();
  const stats = await f.collect();
  assert.equal(stats.fps, 0);
  assert.equal(stats.peerStats[0].receivedFps, 60);
  assert.equal(stats.videoState, 'decoder-stalled');
});

test('stopped screen sharing cannot keep reporting the previous RTP stream', async () => {
  const f = await fixture({ receiving: true });
  f.addPeer('host');
  await f.collect();
  f.engine.members[0].media.screen = false;
  const stats = await f.collect();
  assert.equal(stats.videoState, 'not-sharing');
  assert.equal(stats.fps, null);
  assert.equal(stats.resolution, null);
  assert.equal(f.engine._samples.size, 0);
});

test('capture progress without encode progress identifies an encoder stall', async () => {
  const f = await fixture();
  const viewer = f.addPeer('viewer', { fps: 0, sourceFps: 60 });
  await f.collect(); viewer.advance();
  assert.equal((await f.collect()).videoState, 'encoder-stalled');
});

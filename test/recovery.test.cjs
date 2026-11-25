const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../public/engine.js')).toString('base64'));

test('automatic media recovery coalesces failures and restarts ICE without opening devices', async () => {
  const { MeetingEngine } = await modulePromise; const engine = new MeetingEngine(); engine.selfId = 'a';
  let offers = 0; engine._offer = async (_peer, restart) => { assert.equal(restart, true); offers++; };
  const peer = { id: 'b', pc: { connectionState: 'failed', close() {} }, chain: Promise.resolve(), restartCount: 0 };
  engine._peers.set(peer.id, peer);
  try {
    engine._scheduleMediaRetry(peer); const timer = peer.retryTimer; engine._scheduleMediaRetry(peer);
    assert.equal(peer.retryTimer, timer);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(offers, 1); assert.equal(peer.restartCount, 1); assert.ok(peer.retryWatchdog);
    assert.equal(engine.screenStream, null); assert.equal(engine.cameraStream, null); assert.equal(engine.microphoneStream, null);
  } finally { engine.close(); }
  assert.equal(peer.retryWatchdog, null); assert.equal(peer.retryTimer, null);
});

test('retries stop after the bounded budget and report the private-network/relay requirement once', async () => {
  const { MeetingEngine } = await modulePromise; const events = [];
  const engine = new MeetingEngine({ onEvent: (type, data) => events.push({ type, data }) }); engine.selfId = 'a';
  const peer = { id: 'b', pc: { connectionState: 'failed' }, restartCount: 4 };
  engine._scheduleMediaRetry(peer); engine._scheduleMediaRetry(peer);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.match(events[0].data.message, /No paid relay/); assert.equal(peer.retryTimer, undefined); engine.close();
});

test('the other peer asks the deterministic offerer to retry without creating competing offers', async () => {
  const { MeetingEngine } = await modulePromise; const engine = new MeetingEngine(); engine.selfId = 'b';
  const sent = []; engine._send = message => { sent.push(message); return true; };
  const peer = { id: 'a', pc: { connectionState: 'failed' }, restartCount: 0 };
  try { engine._scheduleMediaRetry(peer); engine._scheduleMediaRetry(peer); assert.deepEqual(sent, [{ type: 'media-retry', to: 'a' }]); }
  finally { engine._clearMediaRetry(peer); engine.close(); }
});

test('manual reconnect resets failed peers and leaves healthy connections untouched', async () => {
  const { MeetingEngine } = await modulePromise; const engine = new MeetingEngine(); engine._assertActive = () => {};
  const failed = { id: 'b', pc: { connectionState: 'failed' }, restartCount: 4, recoveryExhausted: true };
  const healthy = { id: 'c', pc: { connectionState: 'connected' }, restartCount: 0 };
  engine._peers.set('b', failed); engine._peers.set('c', healthy); const scheduled = [];
  engine._scheduleMediaRetry = peer => scheduled.push(peer.id);
  assert.equal(engine.retryMedia(), 1); assert.deepEqual(scheduled, ['b']);
  assert.equal(failed.restartCount, 0); assert.equal(failed.recoveryExhausted, false);
  engine._peers.clear(); engine.close();
});

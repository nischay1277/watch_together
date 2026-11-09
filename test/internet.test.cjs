const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { InternetTunnel, freeServiceError } = require('../desktop/internet.cjs');

test('free-service limits and payment requests have explicit stop messages without claiming an expiry for ordinary errors', () => {
  assert.match(freeServiceError(429), /free public tunnel reached a provider limit/);
  assert.match(freeServiceError(402), /No paid service was started/);
  assert.match(freeServiceError(0, 'free trial expired'), /no longer offers free access/);
  assert.match(freeServiceError(403), /does not by itself identify a quota or expiry/);
  assert.equal(freeServiceError(0, 'DNS lookup failed'), null);
  assert.equal(freeServiceError(200, 'Registered tunnel connection'), null);
});

test('provider HTTP 429 stops the helper and clears the public address without a paid fallback', async () => {
  let killed = false, spawned = 0;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { killed = true; queueMicrotask(() => child.emit('exit', 0)); };
  const tunnel = new InternetTunnel({
    binaryPath: __filename, origin: 'http://127.0.0.1:4317',
    spawnProcess: (_binary, args) => {
      spawned++;
      assert.deepEqual(args, ['tunnel', '--url', 'http://127.0.0.1:4317', '--no-autoupdate', '--protocol', 'http2']);
      queueMicrotask(() => child.stderr.emit('data', Buffer.from('https://fixture-test.trycloudflare.com Registered tunnel connection')));
      return child;
    },
    fetchPublic: async () => ({ status: 429 }),
  });
  await assert.rejects(tunnel.start(), /free public tunnel reached a provider limit/);
  assert.equal(killed, true);
  assert.equal(spawned, 1);
  assert.equal(tunnel.state.state, 'error');
  assert.equal(tunnel.state.url, null);
  assert.match(tunnel.state.error, /No paid service was started/);
  assert.equal(tunnel.process, null);
  assert.equal(tunnel.monitor, null);
});

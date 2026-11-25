const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { installerName, fetchLimited, createNetworkInstaller } = require('../desktop/network-install.cjs');
const { safeNetworkInvite, createNetworkHelper } = require('../desktop/network-helper.cjs');

test('installer selection rejects paths/commands and accepts only the official versioned MSI names', () => {
  assert.equal(installerName({ MSIs: { amd64: 'tailscale-setup-1.104.7-amd64.msi' } }, 'x64'), 'tailscale-setup-1.104.7-amd64.msi');
  for (const name of ['../evil.msi', 'https://evil.example/setup.msi', 'setup.exe', 'tailscale-setup-1.0.0-amd64.msi /quiet']) assert.throws(() => installerName({ MSIs: { amd64: name } }));
});

test('downloader rejects provider errors, oversized bodies and redirects without choosing a paid fallback', async () => {
  await assert.rejects(fetchLimited('https://example.test', 4, async () => new Response('payment', { status: 402 })), /No paid alternative/);
  await assert.rejects(fetchLimited('https://example.test', 4, async () => new Response('12345')), /larger than expected/);
  await assert.rejects(fetchLimited('https://example.test', 4, async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response(null, { status: 302, headers: { location: 'https://evil.example' } }); }));
});

test('installer runs only on explicit request, verifies before launch and keeps files below the supplied data root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'together-install-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const installer = createNetworkInstaller({ dataRoot: root, installed: () => false,
    download: async url => { calls.push('download'); return Buffer.from(url.includes('mode=json') ? JSON.stringify({ MSIs: { amd64: 'tailscale-setup-1.104.7-amd64.msi' } }) : 'test-only'); },
    verify: async file => { assert.equal(path.extname(file), '.msi'); assert.ok(file.startsWith(root)); calls.push('verify'); },
    open: async (file, target) => { assert.ok(fs.existsSync(file)); assert.ok(target.startsWith(root)); calls.push('open'); } });
  assert.equal(installer.status(), null); assert.deepEqual(calls, []);
  const [one, two] = await Promise.all([installer.install(), installer.install()]);
  assert.equal(one.state, 'installer-open'); assert.deepEqual(one, two);
  assert.deepEqual(calls, ['download', 'download', 'verify', 'open']);
});

test('failed publisher verification and an existing installation never launch an installer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'together-install-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existing = createNetworkInstaller({ dataRoot: root, installed: () => true, download: async () => assert.fail('already installed'), open: async () => assert.fail('already installed') });
  assert.equal((await existing.install()).state, 'installed');
  const failed = createNetworkInstaller({ dataRoot: root, installed: () => false,
    download: async url => Buffer.from(url.includes('mode=json') ? JSON.stringify({ MSIs: { amd64: 'tailscale-setup-1.0.0-amd64.msi' } }) : 'unsigned'),
    verify: async () => { throw new Error('Publisher check failed'); }, open: async () => assert.fail('unverified') });
  assert.equal((await failed.install()).state, 'failed');
});

test('network invitations accept only exact official invite URLs and require an explicit user action', async () => {
  const opened = [];
  const helper = createNetworkHelper({ openExternal: async url => opened.push(url) });
  const valid = 'https://login.tailscale.com/uinv/test_only-token';
  assert.equal(safeNetworkInvite(valid), valid);
  assert.deepEqual(opened, []);
  await helper.acceptInvite(valid); assert.deepEqual(opened, [valid]);
  for (const value of ['https://login.tailscale.com.evil.example/uinv/token', 'http://login.tailscale.com/uinv/token', 'https://login.tailscale.com/admin/users', 'https://login.tailscale.com/uinv/token?next=evil', 'file:///D:/anything']) {
    assert.equal(safeNetworkInvite(value), null); await assert.rejects(helper.acceptInvite(value));
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeStatus, createNetworkHelper, safeAuthUrl, findTailscale } = require('../desktop/network-helper.cjs');

test('network summary gives private address and online friends without exposing account or node credentials', () => {
  const result = summarizeStatus({ BackendState: 'Running', TailscaleIPs: ['100.90.2.4'],
    AuthURL: 'https://login.tailscale.com/a/secret', CurrentTailnet: { Name: 'private@example.com' },
    Peer: { secretkey: { HostName: 'Friend PC', TailscaleIPs: ['100.90.2.5'], Online: true, PublicKey: 'secret' } } });
  assert.equal(result.state, 'connected');
  assert.deepEqual(result.peers, [{ name: 'Friend PC', ip: '100.90.2.5', online: true }]);
  assert.doesNotMatch(JSON.stringify(result), /private@example|secret|AuthURL|PublicKey/);
});
test('missing installation and failed/timed-out service checks produce safe actionable states', async () => {
  assert.equal((await createNetworkHelper({ find: () => null }).status()).state, 'missing');
  const helper = createNetworkHelper({ find: () => 'D:\\Tailscale\\tailscale.exe', run: async () => { throw new Error('timeout private@example.com'); } });
  const result = await helper.status();
  assert.equal(result.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private@example/);
});
test('disconnected and pending-approval states stay distinct from a working network', () => {
  assert.equal(summarizeStatus({ BackendState: 'Stopped' }).state, 'stopped');
  assert.equal(summarizeStatus({ BackendState: 'NeedsLogin' }).state, 'login-required');
  assert.equal(summarizeStatus({ BackendState: 'NeedsMachineAuth' }).state, 'approval-required');
  assert.equal(summarizeStatus({ BackendState: 'Running', TailscaleIPs: ['192.168.1.2'] }).state, 'unavailable');
});
test('checking an already connected private network never invokes up or opens another app', async () => {
  const calls = [];
  const helper = createNetworkHelper({ find: () => 'D:\\Tailscale\\tailscale.exe',
    run: async (file, args) => { calls.push(args); return JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.1.2'] }); },
    openExternal: async () => assert.fail('must stay in Together') });
  assert.equal((await helper.connect()).state, 'connected');
  assert.deepEqual(calls, [['status', '--json']]);
});
test('explicit Connect uses fixed CLI args and opens only the official login URL', async () => {
  const calls = [], opened = [];
  const helper = createNetworkHelper({ find: () => 'D:\\Tailscale\\tailscale.exe', run: async (file, args) => {
    calls.push(args); if (args[0] === 'up') return '';
    return JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/example' });
  }, openExternal: async url => opened.push(url) });
  assert.equal((await helper.connect()).authUrlOpened, true);
  assert.deepEqual(calls, [['status', '--json'], ['up', '--timeout=5s'], ['status', '--json']]);
  assert.deepEqual(opened, ['https://login.tailscale.com/a/example']);
  for (const value of ['file:///D:/anything', 'https://login.tailscale.com.evil.example/', 'https://user:pass@login.tailscale.com/', 'http://login.tailscale.com/']) assert.equal(safeAuthUrl(value), null);
});
test('Tailscale lookup uses known absolute installation directories', () => {
  assert.equal(findTailscale({ env: { ProgramFiles: 'D:\\Programs' }, exists: file => file === 'D:\\Programs\\Tailscale\\tailscale.exe' }), 'D:\\Programs\\Tailscale\\tailscale.exe');
});

test('network selection lists only display fields and switches only to a fresh allowlisted profile ID', async () => {
  const calls = [];
  const helper = createNetworkHelper({ find: () => 'D:\\Tailscale\\tailscale.exe', run: async (_exe, args) => {
    calls.push(args);
    if (args[0] === 'switch' && args[1] === '--list') return JSON.stringify([{ id: 'profile1', tailnet: 'Friends network', account: 'private@example.com', secret: 'do-not-expose', selected: false }]);
    if (args[0] === 'switch') return 'Success';
    return JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.1.1'] });
  } });
  assert.deepEqual(await helper.profiles(), [{ id: 'profile1', label: 'Friends network', selected: false }]);
  await assert.rejects(helper.switchProfile('--reset')); await assert.rejects(helper.switchProfile('not-signed-in'));
  assert.equal((await helper.switchProfile('profile1')).state, 'connected');
  assert.deepEqual(calls.filter(args => args[0] === 'switch' && args[1] !== '--list'), [['switch', 'profile1']]);
});

test('adding a network opens only an official browser sign-in and never returns an auth key or login URL', async () => {
  const calls = [], opened = [];
  const helper = createNetworkHelper({ find: () => 'D:\\Tailscale\\tailscale.exe', run: async (_exe, args) => {
    calls.push(args); return args[0] === 'login' ? 'To authenticate, visit https://login.tailscale.com/a/test-only' : JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.1.1'] });
  }, openExternal: async url => opened.push(url) });
  const result = await helper.addProfile(); assert.equal(result.authUrlOpened, true);
  assert.deepEqual(calls[0], ['login', '--timeout=5s']); assert.deepEqual(opened, ['https://login.tailscale.com/a/test-only']);
  assert.doesNotMatch(JSON.stringify(result), /test-only|AuthURL|authkey/);
});

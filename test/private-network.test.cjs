const test = require('node:test');
const assert = require('node:assert/strict');
const { privateNetworkOrigin } = require('../desktop/private-network.cjs');
test('private invites use a detected Tailscale IPv4 adapter and the local room-server port', () => {
  assert.equal(privateNetworkOrigin({ Tailscale: [{ family: 'IPv4', address: '100.64.0.9', internal: false }] }, 4317), 'http://100.64.0.9:4317');
});
test('ordinary LAN, out-of-range addresses, loopback, and missing private adapters are not advertised as a tailnet', () => {
  assert.equal(privateNetworkOrigin({ Ethernet: [{ family: 'IPv4', address: '100.64.0.9', internal: false }] }, 4317), null);
  assert.equal(privateNetworkOrigin({ Tailscale: [{ family: 'IPv4', address: '100.200.0.9', internal: false }] }, 4317), null);
  assert.equal(privateNetworkOrigin({ Tailscale: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }, 4317), null);
  assert.equal(privateNetworkOrigin({}, 4317), null);
});

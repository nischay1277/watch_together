const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInvitation } = require('../desktop/deep-link.cjs');

test('app links preserve the exact server and case-sensitive room secret', () => {
  const link = new URL('together-watch://join');
  link.searchParams.set('server', 'https://test.trycloudflare.com');
  link.searchParams.set('code', 'abcdefgh-AbCd1234_--x');
  assert.deepEqual(parseInvitation(link.href), { server: 'https://test.trycloudflare.com', code: 'ABCDEFGH-AbCd1234_--x' });
});
test('app links reject commands, non-web servers, credentials, and malformed room codes', () => {
  for (const value of ['file:///D:/anything', 'together-watch://run?command=hello',
    'together-watch://join?server=file:///D:/&code=ABCDEFGH-AbCd1234_--x',
    'together-watch://join?server=https://user:pass@example.com&code=ABCDEFGH-AbCd1234_--x',
    'together-watch://join?server=https://example.com/path&code=ABCDEFGH-AbCd1234_--x',
    'together-watch://join?server=https://example.com&code=wrong']) assert.equal(parseInvitation(value), null);
});

require('../tools/task-env.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPartyStore, normalizeParty, startStableServer } = require('../desktop/party-store.cjs');
const invite = 'http://100.64.1.2:4317/#code=ABCDEFGH-AbCd1234_--x';
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'together-parties-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('saved party invitations and titles survive restart without persisting other input fields', t => {
  const file = path.join(temporary(t), 'saved-parties.json');
  const result = createPartyStore(file).save({ title: 'Movie night', invite, password: 'should-not-save' });
  assert.equal(result.length, 1);
  assert.deepEqual(createPartyStore(file).list(), result);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /password|should-not-save/);
  assert.equal(createPartyStore(file).save({ title: 'Renamed', invite }).length, 1);
  assert.equal(createPartyStore(file).remove(result[0].id).length, 0);
});
test('saved invitations reject command URLs, credentials and incomplete secrets', () => {
  for (const invite of ['file:///D:/foo', 'javascript:alert(1)', 'http://user:pass@example.com/#code=ABCDEFGH-AbCd1234_--x', 'https://example.com/#code=ABCDEFGH']) assert.throws(() => normalizeParty({ invite }));
});
test('corrupt party storage is reported instead of silently replacing saved credentials', t => {
  const file = path.join(temporary(t), 'saved-parties.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => createPartyStore(file).save({ invite }), /could not be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('room server reuses its saved listener port and preserves party store options', async t => {
  const dataRoot = temporary(t), calls = [];
  const factory = async options => { calls.push(options); return { port: options.port || 5000, close: async () => {} }; };
  await startStableServer({ dataRoot, createServer: factory, options: { partyStorePath: 'D:\\hosted.json' } });
  await startStableServer({ dataRoot, createServer: factory });
  assert.equal(calls[0].port, 4317);
  assert.equal(calls[0].partyStorePath, 'D:\\hosted.json');
  assert.equal(calls[1].port, 4317);
});
test('a busy listener selects and saves a new port while other server errors are surfaced', async t => {
  const dataRoot = temporary(t), calls = [];
  const started = await startStableServer({ dataRoot, createServer: async options => {
    calls.push(options.port);
    if (options.port) throw Object.assign(new Error('Busy'), { code: 'EADDRINUSE' });
    return { port: 5001, close: async () => {} };
  } });
  assert.deepEqual(calls, [4317, 0]);
  assert.equal(started.portChanged, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, 'server-settings.json'))).port, 5001);
  await assert.rejects(startStableServer({ dataRoot, createServer: async () => { throw new Error('Bad storage'); } }), /Bad storage/);
});

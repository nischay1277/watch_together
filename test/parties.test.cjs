'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createTogetherServer } = require('../server.cjs');

async function setup(t, options = {}) {
  const server = await createTogetherServer({ host: '127.0.0.1', port: 0, ...options });
  const sockets = [];
  t.after(async () => { sockets.forEach(ws => ws.terminate()); await server.close(); });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const messages = [], waiters = [];
    ws.on('message', data => {
      const message = JSON.parse(data);
      const index = waiters.findIndex(waiter => waiter.match(message));
      if (index < 0) messages.push(message);
      else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return {
      ws, send: message => ws.send(JSON.stringify(message)),
      next(type, predicate = () => true) {
        const match = message => message.type === type && predicate(message);
        const index = messages.findIndex(match);
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { match, resolve };
          waiter.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${type}`));
          }, 3000);
          waiters.push(waiter);
        });
      },
      close() { return new Promise(resolve => { ws.once('close', resolve); ws.close(); }); },
    };
  }
  return { ...server, connect };
}

async function storage(t) {
  const directory = path.join(__dirname, '../.tmp', `parties-${crypto.randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  // This exact generated directory is inside the test workspace.
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'hosted-parties.json');
}

test('a party survives everyone leaving, reports authenticated presence, and reuses its code', async t => {
  const app = await setup(t);
  const owner = await app.connect();
  owner.send({ type: 'create-party', name: 'Owner', partyName: 'Movie night' });
  const created = await owner.next('welcome');
  assert.equal(created.persistent, true); assert.equal(created.title, 'Movie night');
  const watcher = await app.connect();
  watcher.send({ type: 'party-status', code: created.code, requestId: 'live' });
  const live = await watcher.next('party-status');
  assert.equal(live.title, 'Movie night'); assert.equal(live.members[0].name, 'Owner');
  assert.equal(live.presenterId, null);
  const left = new Promise(resolve => owner.ws.once('close', resolve));
  owner.send({ type: 'leave' }); await left;
  watcher.send({ type: 'party-status', code: created.code, requestId: 'empty' });
  const empty = await watcher.next('party-status');
  assert.equal(empty.exists, true); assert.deepEqual(empty.members, []);
  watcher.send({ type: 'join', name: 'Back again', code: created.code });
  const rejoined = await watcher.next('welcome');
  assert.equal(rejoined.code, created.code); assert.equal(rejoined.persistent, true);
  assert.equal(rejoined.role, 'host'); assert.equal(rejoined.selfId, rejoined.hostId);
});

test('party host departure transfers host and frees screen sharing without ending the party', async t => {
  const app = await setup(t);
  const owner = await app.connect(); owner.send({ type: 'create-party', name: 'Owner', partyName: 'Friends' });
  const created = await owner.next('welcome');
  const guest = await app.connect(); guest.send({ type: 'join', name: 'Friend', code: created.code });
  const joined = await guest.next('welcome');
  owner.send({ type: 'screen-claim', requestId: 'present', systemAudio: true });
  assert.equal((await owner.next('screen-claim-result')).accepted, true);
  await guest.next('members', message => message.members.some(person => person.media.screen));
  await owner.close();
  const remaining = await guest.next('members', message => message.members.length === 1);
  assert.equal(remaining.hostId, joined.selfId); assert.equal(remaining.members[0].role, 'host');
  assert.equal(remaining.members[0].media.screen, false);
  guest.send({ type: 'screen-claim', requestId: 'handoff' });
  assert.equal((await guest.next('screen-claim-result')).accepted, true);
});

test('party codes persist across server restarts without persisting participant names or media', async t => {
  const partyStorePath = await storage(t);
  const first = await setup(t, { partyStorePath });
  const owner = await first.connect();
  owner.send({ type: 'create-party', name: 'PRIVATE PARTICIPANT NAME', partyName: 'Weekly party' });
  const created = await owner.next('welcome');
  owner.send({ type: 'media', media: { camera: true } });
  await owner.next('members', message => message.members[0].media.camera);
  const saved = await fs.readFile(partyStorePath, 'utf8');
  assert.ok(saved.includes(created.code)); assert.ok(!saved.includes('PRIVATE PARTICIPANT NAME'));
  assert.ok(!saved.includes('media')); assert.ok(!saved.includes('members'));
  await first.close();
  const second = await setup(t, { partyStorePath });
  const client = await second.connect();
  client.send({ type: 'party-status', code: created.code, requestId: 'restored' });
  const snapshot = await client.next('party-status');
  assert.equal(snapshot.title, 'Weekly party'); assert.deepEqual(snapshot.members, []);
  client.send({ type: 'join', name: 'New session', code: created.code });
  assert.equal((await client.next('welcome')).code, created.code);
});

test('party presence does not reveal names to a missing or wrong secret', async t => {
  const app = await setup(t);
  const owner = await app.connect(); owner.send({ type: 'create-party', name: 'Private friend', partyName: 'Private title' });
  const created = await owner.next('welcome');
  const intruder = await app.connect();
  const wrong = created.code.slice(0, -1) + (created.code.endsWith('A') ? 'B' : 'A');
  for (const [index, code] of [undefined, created.code.slice(0, 8), wrong].entries()) {
    intruder.send({ type: 'party-status', code, requestId: String(index) });
    const snapshot = await intruder.next('party-status');
    assert.deepEqual(snapshot, { type: 'party-status', requestId: String(index), exists: false });
  }
  intruder.send({ type: 'party-status', code: created.code, requestId: 42 });
  assert.equal((await intruder.next('error')).code, 'BAD_MESSAGE');
});

test('corrupt party files fail clearly and are not overwritten', async t => {
  const partyStorePath = await storage(t);
  const invalid = '{ this is damaged'; await fs.writeFile(partyStorePath, invalid);
  await assert.rejects(createTogetherServer({ port: 0, partyStorePath }), /Saved parties are damaged/);
  assert.equal(await fs.readFile(partyStorePath, 'utf8'), invalid);
});

test('party persistence failure is reported without creating an unsaved party', async t => {
  const filename = await storage(t);
  const blockedParent = path.join(path.dirname(filename), 'blocked-parent');
  const app = await setup(t, { partyStorePath: path.join(blockedParent, 'parties.json') });
  await fs.writeFile(blockedParent, 'A file now occupies the expected directory.');
  const owner = await app.connect(); owner.send({ type: 'create-party', partyName: 'Cannot save' });
  assert.equal((await owner.next('error')).code, 'PARTY_SAVE_FAILED');
  owner.send({ type: 'create', name: 'Still not joined' });
  assert.equal((await owner.next('welcome')).persistent, false);
});

test('party titles are bounded and sanitised without requiring a storage path', async t => {
  const app = await setup(t);
  const owner = await app.connect(); owner.send({ type: 'create-party', partyName: '\u0000  Clean title  \u0001' });
  const created = await owner.next('welcome'); assert.equal(created.title, 'Clean title');
  assert.equal(created.members[0].name, 'Guest');
});

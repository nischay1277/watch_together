'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createTogetherServer } = require('../server.cjs');

async function setup(t, options = {}) {
  const server = await createTogetherServer({ host: '127.0.0.1', port: 0, ...options });
  const sockets = [];
  t.after(async () => { sockets.forEach((ws) => ws.terminate()); await server.close(); });
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const queue = [];
    const waiters = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data);
      const index = waiters.findIndex((item) => item.predicate(message));
      if (index < 0) queue.push(message);
      else { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timeout); waiter.resolve(message); }
    });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return {
      ws,
      send: (message) => ws.send(JSON.stringify(message)),
      next(type, predicate = () => true) {
        const matches = (message) => message.type === type && predicate(message);
        const index = queue.findIndex(matches);
        if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { predicate: matches, resolve };
          waiter.timeout = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`Timed out waiting for ${type}`));
          }, 3000);
          waiters.push(waiter);
        });
      },
    };
  }
  return { ...server, connect, origin: `http://127.0.0.1:${server.port}` };
}

test('public tunnel origins are added on start and revoked on stop', async t => {
  const app = await setup(t);
  const tunnelOrigin = 'https://test-public-room.trycloudflare.com';
  app.setPublicUrl(tunnelOrigin);
  assert.equal((await fetch(`${app.origin}/api/config`).then(response => response.json())).publicUrl, tunnelOrigin);
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: tunnelOrigin });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.terminate();
  app.setPublicUrl(null);
  assert.equal((await fetch(`${app.origin}/api/config`).then(response => response.json())).publicUrl, null);
  const revoked = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: tunnelOrigin });
  const error = await new Promise(resolve => revoked.once('error', resolve));
  assert.match(error.message, /403/);
});

test('clickable legacy meeting paths redirect to browser-safe fragment invites', async t => {
  const app = await setup(t);
  const code = 'ABCDEFGH-AbCd1234_--x';
  const redirect = await fetch(`${app.origin}/${code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), `/#code=${code}`);
  const head = await fetch(`${app.origin}/${code}`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(head.status, 303);
  assert.equal((await fetch(`${app.origin}/not-a-meeting-code`)).status, 404);
  const page = await fetch(`${app.origin}/${code}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="meeting-code"/);
});

test('meeting code joins one room; chat and mesh signaling identify the authenticated sender', async (t) => {
  const app = await setup(t);
  const host = await app.connect();
  host.send({ type: 'create', name: 'Host' });
  const created = await host.next('welcome');
  assert.match(created.code, /^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/);
  assert.equal(created.role, 'host');
  assert.equal(created.selfId, created.hostId);
  assert.deepEqual(created.members[0].media, { camera: false, microphone: false, screen: false, systemAudio: false });
  const guest = await app.connect();
  guest.send({ type: 'join', code: created.code.slice(0, 8).toLowerCase() + created.code.slice(8), name: 'Guest' });
  const joined = await guest.next('welcome');
  assert.equal(joined.members.length, 2);
  assert.equal(joined.role, 'guest');
  const roster = await host.next('members', (message) => message.members.length === 2);
  assert.equal(roster.members[1].id, joined.selfId);
  guest.send({ type: 'chat', text: 'Can you hear the stream?', from: 'forged' });
  const chat = await host.next('chat');
  assert.equal(chat.from, joined.selfId);
  assert.equal(chat.name, 'Guest');
  assert.equal(chat.text, 'Can you hear the stream?');
  host.send({ type: 'signal', to: joined.selfId, from: 'forged', description: { type: 'offer', sdp: 'test offer' } });
  const offer = await guest.next('signal');
  assert.equal(offer.from, created.selfId);
  assert.equal(offer.description.sdp, 'test offer');
  guest.send({ type: 'signal', to: created.selfId, candidate: { candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal((await host.next('signal')).candidate.candidate, 'candidate:test');
});

test('invalid codes, malformed messages, and cross-room signaling are rejected', async (t) => {
  const app = await setup(t);
  const first = await app.connect();
  first.send({ type: 'create', name: 'First host' });
  const roomOne = await first.next('welcome');
  const second = await app.connect();
  second.send({ type: 'join', code: roomOne.code.slice(0, -1) + (roomOne.code.endsWith('A') ? 'B' : 'A'), name: 'Intruder' });
  assert.equal((await second.next('error')).code, 'INVALID_CODE');
  second.ws.send('{bad JSON');
  assert.equal((await second.next('error')).code, 'BAD_MESSAGE');
  second.send({ type: 'create', name: 'Second host' });
  const roomTwo = await second.next('welcome');
  first.send({ type: 'signal', to: roomTwo.selfId, description: { type: 'offer', sdp: 'cross-room' } });
  assert.equal((await first.next('error')).code, 'INVALID_PEER');
  first.send({ type: 'create', name: 'Again' });
  assert.equal((await first.next('error')).code, 'ALREADY_JOINED');
  first.send({ type: 'chat', text: 'x'.repeat(2001) });
  assert.equal((await first.next('error')).code, 'BAD_CHAT');
});

test('guest cameras and microphones are allowed; screen sharing remains host-only', async (t) => {
  const app = await setup(t);
  const host = await app.connect();
  host.send({ type: 'create', name: 'Host' });
  const created = await host.next('welcome');
  const guest = await app.connect();
  guest.send({ type: 'join', code: created.code, name: 'Guest' });
  const joined = await guest.next('welcome');
  await guest.next('members', (message) => message.members.length === 2);
  guest.send({ type: 'media', media: { camera: true, microphone: true } });
  const roster = await host.next('members', (message) => message.members.some((person) => person.id === joined.selfId && person.media.camera));
  assert.equal(roster.members.find((person) => person.id === joined.selfId).media.microphone, true);
  await guest.next('members', (message) => message.members.some((person) => person.id === joined.selfId && person.media.camera));
  guest.send({ type: 'media', media: { screen: true, systemAudio: true } });
  assert.equal((await guest.next('error')).code, 'HOST_ONLY');
  host.send({ type: 'media', media: { screen: true, systemAudio: true } });
  const sharing = await guest.next('members', (message) => message.members.some((person) => person.id === created.selfId && person.media.screen));
  assert.equal(sharing.members.find((person) => person.id === created.selfId).media.systemAudio, true);
  host.send({ type: 'media', media: { screen: false } });
  const stopped = await guest.next('members', (message) => message.members.some((person) => person.id === created.selfId && !person.media.screen && !person.media.systemAudio));
  assert.equal(stopped.hostId, created.selfId);
});

test('room capacity is enforced; leaving frees capacity; host exit ends the room', async (t) => {
  const app = await setup(t, { maxMembers: 2 });
  const host = await app.connect();
  host.send({ type: 'create', name: 'Host' });
  const created = await host.next('welcome');
  await host.next('members', (message) => message.members.length === 1);
  const guest = await app.connect();
  guest.send({ type: 'join', code: created.code, name: 'Guest' });
  await guest.next('welcome');
  const extra = await app.connect();
  extra.send({ type: 'join', code: created.code });
  assert.equal((await extra.next('error')).code, 'ROOM_FULL');
  guest.ws.close();
  await host.next('members', (message) => message.members.length === 1);
  extra.send({ type: 'join', code: created.code, name: 'Replacement' });
  await extra.next('welcome');
  host.send({ type: 'leave' });
  await extra.next('room-ended');
  const late = await app.connect();
  late.send({ type: 'join', code: created.code });
  assert.equal((await late.next('error')).code, 'INVALID_CODE');
});

test('HTTP exposes no secrets, prevents file traversal, and restricts websocket origins', async (t) => {
  const app = await setup(t, { publicUrl: 'https://together.example' });
  const response = await fetch(`${app.origin}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { publicUrl: 'https://together.example', maxMembers: 6 });
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${app.origin}/server.cjs`)).status, 404);
  assert.equal((await fetch(`${app.origin}/%2e%2e%2fserver.cjs`)).status, 404);
  assert.equal((await fetch(`${app.origin}/api/config`, { method: 'POST' })).status, 405);
  assert.deepEqual(await (await fetch(`${app.origin}/health`)).json(), { status: 'ok' });
  const bad = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', { origin: 'https://untrusted.example' });
  const status = await new Promise((resolve, reject) => {
    bad.on('unexpected-response', (_, rejected) => { resolve(rejected.statusCode); rejected.resume(); });
    bad.on('open', () => reject(new Error('Unexpectedly accepted foreign origin')));
    bad.on('error', () => {});
  });
  bad.terminate();
  assert.equal(status, 403);
});

test('meeting-code secret is case-sensitive', async (t) => {
  const app = await setup(t);
  const host = await app.connect();
  host.send({ type: 'create', name: 'Host' });
  const created = await host.next('welcome');
  const guest = await app.connect();
  const secret = created.code.slice(9);
  const letterIndex = [...secret].findIndex((letter) => /[a-zA-Z]/.test(letter));
  // The probability of all 12 secret characters being nonletters is negligible; handle it without flakiness.
  const index = letterIndex < 0 ? 0 : letterIndex;
  const old = secret[index];
  const changed = /[a-z]/.test(old) ? old.toUpperCase() : /[A-Z]/.test(old) ? old.toLowerCase() : old === '1' ? '2' : '1';
  guest.send({ type: 'join', code: `${created.code.slice(0, 9)}${secret.slice(0, index)}${changed}${secret.slice(index + 1)}` });
  assert.equal((await guest.next('error')).code, 'INVALID_CODE');
});

'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const EMPTY_MEDIA = Object.freeze({ camera: false, microphone: false, screen: false, systemAudio: false });
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/engine.js', ['engine.js', 'text/javascript; charset=utf-8']],
  ['/feedback.js', ['feedback.js', 'text/javascript; charset=utf-8']],
  ['/network-setup.js', ['network-setup.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: http: wss: ws:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

function makeRoomId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // Five random bytes supply exactly eight base32 characters (40 bits).
  const bits = [...crypto.randomBytes(5)].map((value) => value.toString(2).padStart(8, '0')).join('');
  return Array.from({ length: 8 }, (_, i) => alphabet[parseInt(bits.slice(i * 5, i * 5 + 5), 2)]).join('');
}

function normaliseCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (code.length !== 21) return null;
  const normalised = code.slice(0, 8).toUpperCase() + code.slice(8);
  return /^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/.test(normalised) ? normalised : null;
}

function nameOf(value) {
  if (typeof value !== 'string') return 'Guest';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Guest';
}

function publicUrlOf(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function allowOrigin(origin, host, additionalOrigins) {
  if (!origin) return true; // CLI clients do not send Origin; the room code still authenticates them.
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.host === host) return true;
    // A packaged desktop client always serves its renderer on the local loopback server.
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    return additionalOrigins.has(url.origin);
  } catch { return false; }
}

function cleanSignal(message) {
  const clean = {};
  if (message.description !== undefined) {
    const description = message.description;
    if (!description || !['offer', 'answer'].includes(description.type)
      || typeof description.sdp !== 'string' || description.sdp.length > 60000) return null;
    clean.description = { type: description.type, sdp: description.sdp };
  }
  if (message.candidate !== undefined) {
    if (message.candidate === null) clean.candidate = null;
    else {
      const candidate = message.candidate;
      if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192) return null;
      if (candidate.sdpMid != null && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 128)) return null;
      if (candidate.sdpMLineIndex != null && (!Number.isInteger(candidate.sdpMLineIndex)
        || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 64)) return null;
      if (candidate.usernameFragment != null && (typeof candidate.usernameFragment !== 'string'
        || candidate.usernameFragment.length > 256)) return null;
      clean.candidate = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        ...(candidate.usernameFragment == null ? {} : { usernameFragment: candidate.usernameFragment }),
      };
    }
  }
  return Object.keys(clean).length ? clean : null;
}

const MAX_PARTIES = 100;
function partyTitle(value) {
  return (typeof value === 'string' ? value : 'Friends party')
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Friends party';
}

function loadParties(filename) {
  if (!filename) return [];
  let text;
  try {
    if (fsSync.statSync(filename).size > 100000) throw new Error('Party file is too large.');
    text = fsSync.readFileSync(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Saved parties could not be read. Keep the existing party file and restore a valid backup.');
  }
  try {
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.parties) || data.parties.length > MAX_PARTIES) throw new Error();
    const ids = new Set();
    return data.parties.map(party => {
      const code = normaliseCode(party?.code);
      if (!code || ids.has(code.slice(0, 8)) || typeof party.title !== 'string'
        || party.title !== partyTitle(party.title) || !Number.isFinite(party.createdAt)) throw new Error();
      ids.add(code.slice(0, 8));
      return { code, title: party.title, createdAt: party.createdAt };
    });
  } catch {
    throw new Error('Saved parties are damaged. Keep the existing party file and restore a valid backup; party codes were not replaced.');
  }
}

/** Room signaling with optional persisted parties. Media is sent directly over WebRTC. */
async function createTogetherServer(options = {}) {
  const host = options.host ?? process.env.BIND_HOST ?? '0.0.0.0';
  const port = options.port ?? Number(process.env.PORT || 4317);
  const maxMembers = Math.min(12, Math.max(2, Number(options.maxMembers || process.env.MAX_MEMBERS || 6)));
  let publicUrl = publicUrlOf(options.publicUrl ?? process.env.PUBLIC_URL);
  const additionalOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean));
  const configuredOrigins = new Set(additionalOrigins);
  if (publicUrl) additionalOrigins.add(publicUrl);
  const rooms = new Map();
  const partyStorePath = options.partyStorePath;
  for (const party of loadParties(partyStorePath)) {
    const id = party.code.slice(0, 8);
    rooms.set(id, { ...party, id, persistent: true, hostId: null, members: new Map() });
  }
  function persistParty(party) {
    if (!partyStorePath) return;
    const parties = [...rooms.values()].filter(room => room.persistent).concat(party)
      .map(({ code, title, createdAt }) => ({ code, title, createdAt }));
    const temporary = `${partyStorePath}.${crypto.randomUUID()}.tmp`;
    try {
      fsSync.mkdirSync(path.dirname(partyStorePath), { recursive: true });
      fsSync.writeFileSync(temporary, JSON.stringify({ version: 1, parties }), { mode: 0o600, flag: 'wx' });
      fsSync.renameSync(temporary, partyStorePath);
    } finally {
      try { fsSync.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const perIp = new Map();
  const publicDirectory = path.join(__dirname, 'public');
  let shuttingDown = false;

  function iceFor(peerId) {
    if (options.iceServers) return options.iceServers;
    const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const urls = (process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!urls.length) return servers;
    if (process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${peerId}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_PASSWORD) {
      servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_PASSWORD });
    }
    return servers;
  }

  const server = http.createServer(async (request, response) => {
    Object.entries(SECURITY_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end('Bad request'); return; }
    if (pathname === '/health' || pathname === '/api/config') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const payload = pathname === '/health' ? { status: 'ok' } : { publicUrl, maxMembers };
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload));
      return;
    }
    const inviteCode = normaliseCode(pathname.slice(1));
    if (inviteCode) {
      // Legacy meeting codes are also clickable URLs. Keep credentials in the
      // fragment after this redirect, where the browser can prefill the join UI.
      response.writeHead(303, { Location: `/#code=${encodeURIComponent(inviteCode)}` });
      response.end();
      return;
    }
    const file = STATIC_FILES.get(pathname);
    if (!file) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const content = await fs.readFile(path.join(publicDirectory, file[0]));
      response.writeHead(200, { 'Content-Type': file[1], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404); response.end('Not found');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (shuttingDown || pathname !== '/ws' || !allowOrigin(request.headers.origin, request.headers.host, additionalOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = request.socket.remoteAddress || 'unknown';
    if ((perIp.get(address) || 0) >= 60 || wss.clients.size >= 1000) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      perIp.set(address, (perIp.get(address) || 0) + 1);
      ws.on('close', () => {
        const next = (perIp.get(address) || 1) - 1;
        if (next) perIp.set(address, next); else perIp.delete(address);
      });
      wss.emit('connection', ws, request);
    });
  });

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
  function fail(ws, code, message) { send(ws, { type: 'error', code, message }); }
  function membersOf(room) {
    return [...room.members.values()].map((member) => ({
      id: member.id, name: member.name, role: member.role, media: { ...member.media },
    }));
  }
  function broadcast(room, message) { for (const member of room.members.values()) send(member.ws, message); }
  function roster(room) { broadcast(room, { type: 'members', members: membersOf(room), hostId: room.hostId }); }
  function welcome(member) {
    send(member.ws, {
      type: 'welcome', selfId: member.id, hostId: member.room.hostId,
      role: member.role, code: member.room.code, members: membersOf(member.room), iceServers: iceFor(member.id),
      persistent: member.room.persistent === true, title: member.room.title || null,
    });
  }
  function removeMember(member) {
    const room = member?.room;
    if (!room || !room.members.has(member.id)) return;
    clearTimeout(member.shareLease);
    room.members.delete(member.id);
    member.room = null;
    if (room.persistent) {
      if (member.id === room.hostId) {
        const next = room.members.values().next().value;
        room.hostId = next?.id || null;
        if (next) next.role = 'host';
      }
      if (!shuttingDown) roster(room);
    } else if (member.role === 'host') {
      rooms.delete(room.id);
      for (const other of room.members.values()) {
        clearTimeout(other.shareLease);
        send(other.ws, { type: 'room-ended' });
        other.room = null;
        other.ws.close(1000, 'Host ended the room');
      }
      room.members.clear();
    } else if (!shuttingDown) roster(room);
  }

  wss.on('connection', (ws) => {
    let member = null;
    let windowStart = Date.now();
    let messageCount = 0;
    let failedJoins = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // Socket failures are handled by close; do not log room data.
    ws.on('close', () => removeMember(member));
    ws.on('message', (data, isBinary) => {
      if (isBinary) { fail(ws, 'BAD_MESSAGE', 'Use JSON messages.'); return; }
      const now = Date.now();
      if (now - windowStart > 10000) { messageCount = 0; windowStart = now; }
      if (++messageCount > 240) { ws.close(1008, 'Message rate exceeded'); return; }
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { fail(ws, 'BAD_MESSAGE', 'Invalid JSON.'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        fail(ws, 'BAD_MESSAGE', 'Invalid message.'); return;
      }
      if (message.type === 'party-status') {
        if (typeof message.requestId !== 'string' || message.requestId.length > 80) {
          fail(ws, 'BAD_MESSAGE', 'Invalid party status request.'); return;
        }
        const code = normaliseCode(message.code);
        const party = code ? rooms.get(code.slice(0, 8)) : null;
        if (!party?.persistent || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(party.code))) {
          send(ws, { type: 'party-status', requestId: message.requestId, exists: false });
          if (++failedJoins >= 12) ws.close(1008, 'Too many invalid codes');
          return;
        }
        send(ws, { type: 'party-status', requestId: message.requestId, code: party.code, exists: true,
          persistent: true, title: party.title, members: membersOf(party), maxMembers,
          presenterId: [...party.members.values()].find(person => person.media.screen)?.id || null });
        return;
      }
      if (message.type === 'create' || message.type === 'create-party' || message.type === 'join') {
        if (member?.room) { fail(ws, 'ALREADY_JOINED', 'Leave the current room first.'); return; }
        let room;
        let role = 'guest';
        if (message.type === 'create' || message.type === 'create-party') {
          if (rooms.size >= 500) { fail(ws, 'SERVER_FULL', 'The server is full. Try again later.'); return; }
          if (message.type === 'create-party' && [...rooms.values()].filter(room => room.persistent).length >= MAX_PARTIES) {
            fail(ws, 'PARTY_LIMIT', `This server can save up to ${MAX_PARTIES} parties.`); return;
          }
          let id;
          do { id = makeRoomId(); } while (rooms.has(id));
          const code = `${id}-${crypto.randomBytes(9).toString('base64url')}`;
          room = { id, code, hostId: crypto.randomUUID(), members: new Map() };
          if (message.type === 'create-party') {
            Object.assign(room, { persistent: true, title: partyTitle(message.partyName), createdAt: Date.now() });
            try { persistParty(room); }
            catch { fail(ws, 'PARTY_SAVE_FAILED', 'The party could not be saved. Check free disk space and try again.'); return; }
          }
          role = 'host';
          rooms.set(id, room);
        } else {
          const code = normaliseCode(message.code);
          room = code ? rooms.get(code.slice(0, 8)) : null;
          if (!room || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(room.code))) {
            fail(ws, 'INVALID_CODE', 'That meeting code is invalid or the room has ended.');
            if (++failedJoins >= 12) ws.close(1008, 'Too many invalid codes');
            return;
          }
          if (room.members.size >= maxMembers) { fail(ws, 'ROOM_FULL', `This room is limited to ${maxMembers} people.`); return; }
          if (room.persistent && !room.members.size) {
            role = 'host'; room.hostId = crypto.randomUUID();
          }
        }
        member = {
          id: role === 'host' ? room.hostId : crypto.randomUUID(), name: nameOf(message.name), role,
          media: { ...EMPTY_MEDIA }, ws, room,
        };
        room.members.set(member.id, member);
        welcome(member);
        roster(room);
        return;
      }
      if (!member?.room) { fail(ws, 'NOT_JOINED', 'Create or join a room first.'); return; }
      const room = member.room;
      if (message.type === 'screen-claim') {
        if (typeof message.requestId !== 'string' || message.requestId.length > 80) { fail(ws, 'BAD_MESSAGE', 'Invalid screen request.'); return; }
        const sharing = [...room.members.values()].find(person => person.media.screen && person.id !== member.id);
        if (sharing) {
          send(ws, { type: 'screen-claim-result', requestId: message.requestId, accepted: false, message: `${sharing.name} is sharing. Ask them to stop before sharing your screen.` }); return;
        }
        clearTimeout(member.shareLease);
        member.media.screen = true; member.media.systemAudio = message.systemAudio === true;
        member.shareLease = setTimeout(() => {
          if (!member.room) return;
          member.media.screen = member.media.systemAudio = false; roster(member.room);
        }, 15000);
        member.shareLease.unref?.();
        send(ws, { type: 'screen-claim-result', requestId: message.requestId, accepted: true });
        roster(room);
      } else if (message.type === 'screen-release') {
        clearTimeout(member.shareLease);
        member.media.screen = member.media.systemAudio = false; roster(room);
      } else if (message.type === 'media-retry') {
        if (typeof message.to !== 'string' || message.to === member.id || !room.members.has(message.to)) { fail(ws, 'INVALID_PEER', 'That person is no longer in the room.'); return; }
        send(room.members.get(message.to).ws, { type: 'media-retry', from: member.id });
      } else if (message.type === 'signal') {
        if (typeof message.to !== 'string' || message.to === member.id || !room.members.has(message.to)) {
          fail(ws, 'INVALID_PEER', 'That person is no longer in the room.'); return;
        }
        const signal = cleanSignal(message);
        if (!signal) { fail(ws, 'BAD_SIGNAL', 'Invalid WebRTC signal.'); return; }
        send(room.members.get(message.to).ws, { type: 'signal', from: member.id, ...signal });
      } else if (message.type === 'chat') {
        if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000) {
          fail(ws, 'BAD_CHAT', 'Messages must contain 1 to 2,000 characters.'); return;
        }
        broadcast(room, {
          type: 'chat', id: crypto.randomUUID(), from: member.id,
          name: member.name, text: message.text.trim(), time: Date.now(),
        });
      } else if (message.type === 'media') {
        if (!message.media || typeof message.media !== 'object' || Array.isArray(message.media)) {
          fail(ws, 'BAD_MEDIA', 'Invalid media state.'); return;
        }
        if (message.media.screen === true && [...room.members.values()].some(person => person.id !== member.id && person.media.screen)) {
          fail(ws, 'SCREEN_BUSY', 'Someone is already sharing. Ask them to stop before sharing your screen.'); return;
        }
        if (typeof message.media.screen === 'boolean') clearTimeout(member.shareLease);
        for (const key of Object.keys(EMPTY_MEDIA)) {
          if (typeof message.media[key] === 'boolean') member.media[key] = message.media[key];
        }
        if (!member.media.screen) member.media.systemAudio = false;
        roster(room);
      } else if (message.type === 'leave') {
        removeMember(member);
        member = null;
        ws.close(1000, 'Left room');
      } else fail(ws, 'UNKNOWN_TYPE', 'Unknown message type.');
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  }).catch((error) => { clearInterval(heartbeat); wss.close(); throw error; });

  let closing;
  function close() {
    if (closing) return closing;
    shuttingDown = true;
    clearInterval(heartbeat);
    closing = new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
      server.closeIdleConnections?.();
    });
    return closing;
  }
  function setPublicUrl(value) {
    if (publicUrl && !configuredOrigins.has(publicUrl)) additionalOrigins.delete(publicUrl);
    publicUrl = publicUrlOf(value);
    if (publicUrl) additionalOrigins.add(publicUrl);
  }
  return { server, wss, port: server.address().port, close, setPublicUrl };
}

module.exports = { createTogetherServer };

if (require.main === module) {
  createTogetherServer().then((instance) => {
    console.log(`Together signaling server listening on port ${instance.port}.`);
    const shutdown = () => instance.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    console.error(`Cannot start Together server: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

const SLOT_KINDS = ['video', 'audio', 'video', 'audio'];
const DEFAULT_SETTINGS = { fps: 120, resolution: 0, bitrate: 0, codec: 'auto', mode: 'balanced' };

const codecKey = codec => codec ? `${codec.mimeType.toLowerCase()}|${codec.clockRate}|${codec.sdpFmtpLine || ''}` : '';

// Seed the initial congestion estimate for a high-resolution screen. This is
// not a minimum bitrate: congestion control and the user's ceiling still apply.
export function seedScreenBitrate(sdp, kbps) {
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=video ') || !/^a=mid:0\r?$/m.test(section)) return section;
    const payloads = [...section.matchAll(/^a=rtpmap:(\d+) (?:VP8|VP9|H264|H265|AV1)\//gmi)].map(match => match[1]);
    const ending = section.includes('\r\n') ? '\r\n' : '\n';
    for (const payload of payloads) {
      const pattern = new RegExp(`^a=fmtp:${payload} ([^\\r\\n]*)`, 'm');
      if (pattern.test(section)) section = section.replace(pattern, (_, parameters) => {
        const kept = parameters.split(';').filter(value => !/^\s*x-google-start-bitrate\s*=/i.test(value)).join(';');
        return `a=fmtp:${payload} ${kept}${kept ? ';' : ''}x-google-start-bitrate=${kbps}`;
      });
      else section += `a=fmtp:${payload} x-google-start-bitrate=${kbps}${ending}`;
    }
    return section;
  }).join('');
}

/** Select only negotiated codecs; capability hints are checked at the capture size. */
export async function chooseScreenCodec(codecs, { preference = 'auto', width = 1920, height = 1080, fps = 120, bitrate = 0, probe, cache = new Map() } = {}) {
  const order = ['video/h264', 'video/h265', 'video/vp9', 'video/av1', 'video/vp8'];
  const candidates = codecs.filter(codec => order.includes(codec.mimeType.toLowerCase())
    && (preference === 'auto' || codec.mimeType.toLowerCase() === preference.toLowerCase()));
  const rank = codec => {
    const mime = codec.mimeType.toLowerCase();
    const fmtp = codec.sdpFmtpLine || '';
    return order.indexOf(mime) * 100 + (/packetization-mode=0/.test(fmtp) ? 50 : 0)
      + (/profile-level-id=6400/.test(fmtp) ? 0 : /profile-level-id=4d00/.test(fmtp) ? 1 : 2);
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  if (!candidates.length) return null;
  if (probe) {
    const results = await Promise.all(candidates.map(async codec => {
      const contentType = codec.mimeType + (codec.sdpFmtpLine ? '; ' + codec.sdpFmtpLine.replaceAll(';', '; ') : '');
      const configuration = { type: 'webrtc', video: {
        contentType, width, height, framerate: fps,
        bitrate: bitrate > 0 ? bitrate * 1e6 : Math.max(10000000, Math.round(width * height * fps * .15)),
      } };
      const key = JSON.stringify(configuration);
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => probe(configuration)).catch(() => null));
      return { codec, hint: await cache.get(key) };
    }));
    const accelerated = results.find(item => item.hint?.supported && item.hint.powerEfficient && item.hint.smooth)
      || results.find(item => item.hint?.supported && item.hint.powerEfficient);
    if (accelerated) return accelerated.codec;
  }
  // Auto retains the runtime's normal choice when no accelerated codec is reported.
  return preference === 'auto' ? null : candidates[0];
}

export function normalizeSettings(settings = {}) {
  const number = (value, fallback, low, high) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(high, Math.max(low, parsed)) : fallback;
  };
  return {
    fps: number(settings.fps, 120, 15, 240),
    resolution: settings.resolution === 'native' || Number(settings.resolution) === 0 ? 0 : number(settings.resolution, 0, 360, 4320),
    bitrate: Number(settings.bitrate) === 0 ? 0 : number(settings.bitrate, 0, 1, 200),
    codec: ['auto', 'video/VP9', 'video/H264', 'video/AV1'].includes(settings.codec) ? settings.codec : 'auto',
    mode: ['balanced', 'smooth', 'source'].includes(settings.mode) ? settings.mode : 'balanced',
  };
}

// This is a per-viewer sender plan, never a reduction of the shared capture.
// Hysteresis avoids oscillation; no minimum bitrate is forced onto a weak link.
export function adaptiveProfile(settings, capture = {}, sample = {}, previous = {}) {
  const width = capture.width || 1920, height = capture.height || 1080;
  const sourceFps = Math.min(settings.fps, capture.frameRate > 0 ? capture.frameRate : settings.fps);
  const make = (limit, fps) => {
    const scale = Math.max(1, height / limit);
    return { scale, fps: Math.min(sourceFps, fps), width: Math.floor(width / scale), height: Math.floor(height / scale) };
  };
  const base = make(height, sourceFps);
  if (settings.mode === 'source') return { level: 0, bad: 0, good: 0, ...base, maxBitrate: settings.bitrate > 0 ? settings.bitrate * 1e6 : null };
  const smoothFps = Math.min(sourceFps, 60);
  const ladder = [base, make(1080, smoothFps), ...(settings.mode === 'smooth'
    ? [make(720, smoothFps), make(540, smoothFps), make(360, 30)]
    : [make(1080, 30), make(720, 30), make(540, 24), make(360, 20)])]
    .filter((item, index, all) => !all.slice(0, index).some(other => other.scale === item.scale && other.fps === item.fps));
  const budget = profile => Math.max(250000, Math.round(profile.width * profile.height * profile.fps * .065));
  let level = Math.min(previous.level || 0, ladder.length - 1);
  const current = ladder[level];
  const capacity = Number.isFinite(sample.availableMbps) && sample.availableMbps > 0 ? sample.availableMbps * 1e6 * .8 : null;
  const ceiling = settings.bitrate > 0 ? settings.bitrate * 1e6 : null;
  const usable = capacity && ceiling ? Math.min(capacity, ceiling) : capacity || ceiling;
  const pressure = sample.limitation === 'bandwidth' || sample.limitation === 'cpu' || sample.loss > .04
    || (usable !== null && usable < budget(current) * .85);
  const measurable = capacity !== null || sample.limitation === 'none' || Number.isFinite(sample.loss);
  let bad = pressure ? (previous.bad || 0) + 1 : 0;
  let good = !pressure && measurable && (!usable || usable > budget(ladder[Math.max(0, level - 1)]) * 1.2) ? (previous.good || 0) + 1 : 0;
  if (bad >= 3 && level < ladder.length - 1) { level++; bad = 0; good = 0; }
  if (good >= 15 && level > 0) { level--; good = 0; bad = 0; }
  const profile = ladder[level];
  const automatic = Math.min(60000000, Math.max(1000000, budget(profile) * 1.6));
  return { level, bad, good, ...profile, maxBitrate: Math.round(ceiling ? Math.min(automatic, ceiling) : automatic) };
}

/** Authenticated presence lookup; possession of the complete invite is required. */
export function probeParty(serverUrl, code, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, timer, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); socket?.close(); error ? reject(error) : resolve(value); };
    try { socket = new WebSocket(socketUrlFor(serverUrl)); } catch (error) { finish(error); return; }
    const requestId = globalThis.crypto?.randomUUID?.() || String(Date.now());
    timer = setTimeout(() => finish(new Error('Party host is offline or unreachable.')), timeout);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'party-status', code, requestId }));
    socket.onmessage = event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'party-status' && data.requestId === requestId) finish(null, data);
      else if (data.type === 'error') finish(new Error(data.message || 'Party unavailable.'));
    };
    socket.onerror = () => finish(new Error('Party host is offline or unreachable.'));
    socket.onclose = () => finish(new Error('Party host disconnected.'));
  });
}

export function socketUrlFor(serverUrl) {
  let input = String(serverUrl || globalThis.location?.origin || '').trim();
  if (!/^[a-z]+:\/\//i.test(input)) input = `http://${input}`;
  const url = new URL(input);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an http:// or https:// meeting server address.');
  }
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.href;
}

function aliveTrack(stream, kind) {
  return stream?.getTracks().find(track => track.kind === kind && track.readyState === 'live') || null;
}

function stopStream(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

function friendlyMediaError(error, kind) {
  if (error?.name === 'NotAllowedError') return `${kind} permission was denied. Allow access in your browser or Windows privacy settings.`;
  if (error?.name === 'NotFoundError') return `No ${kind.toLowerCase()} device was found.`;
  if (error?.name === 'NotReadableError') return `The ${kind.toLowerCase()} is busy or unavailable. Close other apps using it and try again.`;
  return error?.message || `Could not start the ${kind.toLowerCase()}.`;
}

/** Full-mesh room transport. No device is opened until the user enables it. */
export class MeetingEngine {
  constructor({ serverUrl, name, settings = {}, onEvent = () => {} } = {}) {
    this.serverUrl = serverUrl;
    this.name = String(name || 'Guest').trim().slice(0, 40) || 'Guest';
    this.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
    this.onEvent = onEvent;
    this.selfId = null;
    this.hostId = null;
    this.presenterId = null;
    this._screenClaim = null;
    this.role = null;
    this.code = null;
    this.members = [];
    this.screenStream = null;
    this.cameraStream = null;
    this.microphoneStream = null;
    this._localParticipant = null;
    this._peers = new Map();
    this._samples = new Map();
    this._codecHints = new Map();
    this._socket = null;
    this._closed = false;
    this._ended = false;
    this._pendingWelcome = null;
    this._messageQueue = Promise.resolve();
    this._mediaQueue = Promise.resolve();
    this._screenRevision = 0;
    this._cameraRevision = 0;
    this._microphoneRevision = 0;
    this._statsBusy = false;
    this._onNetworkOnline = () => { if (!this._closed && this.selfId) this.retryMedia(); };
    globalThis.addEventListener?.('online', this._onNetworkOnline);
  }

  create() { return this._open({ type: 'create', name: this.name }); }
  createParty(partyName) { return this._open({ type: 'create-party', name: this.name, partyName }); }
  join(code) { return this._open({ type: 'join', name: this.name, code: String(code || '').trim() }); }

  _emit(type, data) {
    try { this.onEvent(type, data); } catch (error) { console.error('Meeting UI event failed:', type, error); }
  }

  _error(error) {
    if (!this._closed) this._emit('error', { message: error?.message || String(error) });
  }

  _assertActive() {
    if (this._closed || !this.selfId || this._socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Join or create a room first.');
    }
  }

  _open(message) {
    if (this._socket || this._closed) return Promise.reject(new Error('This meeting connection is already in use.'));
    if (!globalThis.RTCPeerConnection) return Promise.reject(new Error('WebRTC is unavailable. Use the desktop app or a current Chrome or Edge browser.'));
    let socket;
    try { socket = new WebSocket(socketUrlFor(this.serverUrl)); }
    catch (error) { return Promise.reject(error); }
    this._socket = socket;
    const privateRoom = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(new URL(socket.url).hostname);
    this._emit('status', { state: 'connecting', message: 'Connecting to the meeting server…' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingWelcome = null;
        reject(new Error('The meeting server did not respond. Check its address and network access.'));
        this._shutdown('timeout', 'Meeting connection timed out.');
      }, 15000);
      this._pendingWelcome = { resolve, reject, timer };
      socket.onopen = () => this._send(message);
      socket.onmessage = event => {
        this._messageQueue = this._messageQueue.then(async () => {
          let data;
          try { data = JSON.parse(event.data); } catch { return; }
          if (!this._closed) await this._receive(data);
        }).catch(error => this._error(error));
      };
      socket.onerror = () => this._emit('status', { state: 'error', message: privateRoom
        ? 'Cannot reach the private room. Connect both PCs to the same Tailscale network, keep the host app running, and check that the host allows incoming connections.'
        : 'Cannot reach the meeting server. Check its address, HTTPS, and firewall settings.' });
      socket.onclose = event => {
        if (!this._closed) this._shutdown('disconnected', event.reason || 'The meeting server disconnected. Your camera, microphone, and screen sharing have stopped.');
      };
    });
  }

  _send(message) {
    if (this._socket?.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  async _receive(message) {
    switch (message.type) {
      case 'welcome': {
        if (this.selfId) return;
        this.selfId = message.selfId;
        this.hostId = message.hostId;
        this.role = message.role;
        this.code = message.code;
        this.persistent = Boolean(message.persistent);
        this.title = message.title || '';
        this._iceServers = message.iceServers || [];
        this._emit('welcome', message);
        await this._syncMembers(message.members || []);
        if (this._closed) return;
        this._statsTimer = setInterval(() => void this._collectStats(), 1000);
        this._emit('status', { state: 'connected', message: 'Room connected. Anyone can share when the screen is free.' });
        if (this._pendingWelcome) {
          clearTimeout(this._pendingWelcome.timer);
          this._pendingWelcome.resolve(message);
          this._pendingWelcome = null;
        }
        break;
      }
      case 'members':
        this.hostId = message.hostId || this.hostId;
        await this._syncMembers(message.members || []);
        break;
      case 'signal': {
        const peer = this._peers.get(message.from);
        if (peer) await this._withPeer(peer, () => this._acceptSignal(peer, message));
        break;
      }
      case 'media-retry': {
        const peer = this._peers.get(message.from);
        if (peer && this.selfId < peer.id) this._scheduleMediaRetry(peer, true);
        break;
      }
      case 'screen-claim-result': {
        const pending = this._screenClaim;
        if (!pending || pending.id !== message.requestId) break;
        clearTimeout(pending.timer); this._screenClaim = null;
        if (message.accepted) pending.resolve();
        else pending.reject(new Error(message.message || 'Someone is already sharing.'));
        break;
      }
      case 'chat': this._emit('chat', message); break;
      case 'room-ended': this._shutdown('room-ended', 'The host ended this meeting.'); break;
      case 'error': {
        const error = new Error(message.message || 'The meeting server rejected the request.');
        if (this._pendingWelcome) {
          clearTimeout(this._pendingWelcome.timer);
          this._pendingWelcome.reject(error);
          this._pendingWelcome = null;
          this._shutdown('rejected', error.message);
        } else this._error(error);
        break;
      }
      default: break;
    }
  }

  async _syncMembers(members) {
    this.members = members;
    this.role = members.find(member => member.id === this.selfId)?.role || this.role;
    this.presenterId = members.find(member => member.media?.screen)?.id || null;
    if (this.screenStream && this.presenterId !== this.selfId && !this._screenClaim) await this.setScreen(null);
    this._emit('members', { members: this.members, hostId: this.hostId });
    const present = new Set(members.map(member => member.id));
    for (const [id, peer] of this._peers) {
      if (!present.has(id)) {
        this._dropPeer(peer);
        this._peers.delete(id);
      }
    }
    for (const member of members) {
      if (member.id === this.selfId || this._closed) continue;
      if (!this._peers.has(member.id)) {
        const peer = this._newPeer(member.id);
        this._peers.set(member.id, peer);
        // Initial offers have a deterministic owner; perfect negotiation also
        // handles later codec changes and simultaneous ICE restarts.
        if (this.selfId < member.id) await this._withPeer(peer, () => this._offer(peer));
      }
    }
    if (!this.presenterId) this._emit('screen', { peerId: null, stream: null });
    else if (this.presenterId === this.selfId && this.screenStream) {
      this._emit('screen', { peerId: this.selfId, stream: this.screenStream });
    } else {
      const hostPeer = this._peers.get(this.presenterId);
      if (hostPeer?.screen.getVideoTracks().length) this._emit('screen', { peerId: this.presenterId, stream: hostPeer.screen });
    }
  }

  _slotTracks() {
    return [aliveTrack(this.screenStream, 'video'), aliveTrack(this.screenStream, 'audio'),
      aliveTrack(this.cameraStream, 'video'), aliveTrack(this.microphoneStream, 'audio')];
  }

  _newPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this._iceServers, bundlePolicy: 'max-bundle' });
    const peer = {
      id, pc, screen: new MediaStream(), participant: new MediaStream(),
      chain: Promise.resolve(), candidates: [], makingOffer: false,
      ignoreOffer: false, settingAnswer: false, polite: this.selfId > id,
      renegotiate: false, restartCount: 0, dropped: false, warnedParameters: false,
    };
    // addTransceiver-created slots are not reused when receiving a first
    // offer. Only its deterministic sender allocates them; the answerer
    // adopts the four transceivers created by setRemoteDescription instead.
    peer.transceivers = [];
    if (this.selfId < id) {
      const tracks = this._slotTracks();
      peer.transceivers = SLOT_KINDS.map((kind, index) => pc.addTransceiver(tracks[index] || kind, { direction: 'sendrecv' }));
      this._codecPreference(peer);
    }
    pc.onicecandidate = event => {
      if (event.candidate) this._send({ type: 'signal', to: id, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = event => {
      const slot = pc.getTransceivers().indexOf(event.transceiver);
      const stream = slot < 2 ? peer.screen : peer.participant;
      if (slot < 0) return;
      if (!stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
      if ('jitterBufferTarget' in event.receiver) {
        try { event.receiver.jitterBufferTarget = slot < 2 ? 70 : 40; } catch { /* Optional browser hint. */ }
      }
      const emitTrack = () => {
        if (peer.dropped || this._closed) return;
        if (slot < 2 && id === this.presenterId) this._emit('screen', { peerId: id, stream: peer.screen });
        if (slot >= 2) this._emit('participant-stream', { peerId: id, stream: peer.participant });
      };
      event.track.onunmute = emitTrack;
      emitTrack();
    };
    pc.onconnectionstatechange = () => {
      if (peer.dropped || this._closed) return;
      if (pc.connectionState === 'connected') {
        this._clearMediaRetry(peer); peer.restartCount = 0; peer.recoveryExhausted = false;
        this._emit('status', { state: 'peer-connected', peerId: id, message: 'Participant media connected.' });
        void this._withPeer(peer, () => this._applySenders(peer));
      } else if (pc.connectionState === 'failed') {
        this._scheduleMediaRetry(peer);
      } else if (pc.connectionState === 'disconnected') {
        this._emit('status', { state: 'peer-disconnected', peerId: id, message: 'A participant’s media connection was interrupted.' });
        this._scheduleMediaRetry(peer);
      }
    };
    peer.initialTimer = setTimeout(() => { peer.initialTimer = null; if (pc.connectionState !== 'connected') this._scheduleMediaRetry(peer); }, 20000);
    return peer;
  }

  _clearMediaRetry(peer) {
    for (const key of ['initialTimer', 'retryTimer', 'retryWatchdog', 'retryNotice']) { clearTimeout(peer[key]); peer[key] = null; }
  }

  _scheduleMediaRetry(peer, requested = false) {
    if (this._closed || peer.dropped || peer.pc.connectionState === 'closed') return;
    if (peer.pc.connectionState === 'connected' && !requested) return;
    if (this.selfId > peer.id) {
      if (!peer.retryNotice) {
        this._send({ type: 'media-retry', to: peer.id });
        peer.retryNotice = setTimeout(() => { peer.retryNotice = null; }, 5000);
      }
      return;
    }
    if (peer.retryTimer || peer.retryWatchdog) return;
    if (peer.restartCount >= 4) {
      if (!peer.recoveryExhausted) this._error(new Error('Media could not connect after automatic retries. Connect both PCs to the same private network or configure TURN, then click Reconnect media. No paid relay was started.'));
      peer.recoveryExhausted = true; return;
    }
    this._emit('status', { state: 'media-retrying', message: `Restoring a participant’s media connection (${peer.restartCount + 1}/4). Camera and screen choices are kept.` });
    peer.retryTimer = setTimeout(async () => {
      peer.retryTimer = null;
      if (this._closed || peer.dropped || (peer.pc.connectionState === 'connected' && !requested)) return;
      peer.restartCount++;
      try { await this._withPeer(peer, () => this._offer(peer, true)); }
      catch (error) { if (!this._closed && !peer.dropped) this._error(error); }
      if (!this._closed && !peer.dropped && peer.pc.connectionState !== 'connected') {
        peer.retryWatchdog = setTimeout(() => { peer.retryWatchdog = null; this._scheduleMediaRetry(peer); }, 12000);
      }
    }, [1000, 3000, 8000, 15000][peer.restartCount]);
  }

  retryMedia() {
    this._assertActive();
    let count = 0;
    for (const peer of this._peers.values()) {
      if (peer.dropped || peer.pc.connectionState === 'connected') continue;
      this._clearMediaRetry(peer); peer.restartCount = 0; peer.recoveryExhausted = false;
      this._scheduleMediaRetry(peer); count++;
    }
    return count;
  }

  _withPeer(peer, operation) {
    const result = peer.chain.then(() => {
      if (!this._closed && !peer.dropped) return operation();
    });
    peer.chain = result.catch(error => this._error(error));
    return peer.chain;
  }

  async _offer(peer, iceRestart = false) {
    const { pc } = peer;
    if (!peer.transceivers.length) { peer.renegotiate = true; return; }
    if (pc.signalingState !== 'stable') { peer.renegotiate = true; return; }
    try {
      peer.makingOffer = true;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (peer.dropped || this._closed) return;
      offer.sdp = seedScreenBitrate(offer.sdp, this._startBitrate(peer));
      await pc.setLocalDescription(offer);
      this._send({ type: 'signal', to: peer.id, description: pc.localDescription.toJSON() });
    } finally { peer.makingOffer = false; }
  }

  _startBitrate(peer) {
    if (!peer.startBitrateKbps) {
      const capture = aliveTrack(this.screenStream, 'video')?.getSettings() || {};
      const automatic = Math.min(25000, Math.max(3000, Math.round((capture.width || 1920) * (capture.height || 1080) * Math.min(this.settings.fps, 120) * .04 / 1000)));
      const initial = this.settings.mode === 'source' ? automatic : Math.min(automatic, this.settings.mode === 'smooth' ? 2500 : 4000);
      peer.startBitrateKbps = this.settings.bitrate > 0 ? Math.min(initial, this.settings.bitrate * 1000) : initial;
    }
    return peer.startBitrateKbps;
  }

  async _acceptSignal(peer, message) {
    const { pc } = peer;
    if (message.description) {
      const description = message.description;
      const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
      const offerCollision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = description.type === 'answer';
      try { await pc.setRemoteDescription(description); }
      finally { peer.settingAnswer = false; }
      for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (description.type === 'offer') {
        peer.transceivers = pc.getTransceivers();
        const tracks = this._slotTracks();
        for (let slot = 0; slot < SLOT_KINDS.length; slot++) {
          const transceiver = peer.transceivers[slot];
          if (!transceiver || transceiver.receiver.track.kind !== SLOT_KINDS[slot]) {
            throw new Error('The participant sent incompatible media slots. Rejoin the meeting with the same app version.');
          }
          transceiver.direction = 'sendrecv';
          await transceiver.sender.replaceTrack(tracks[slot]);
        }
        this._codecPreference(peer);
        const answer = await pc.createAnswer();
        answer.sdp = seedScreenBitrate(answer.sdp, this._startBitrate(peer));
        await pc.setLocalDescription(answer);
        this._send({ type: 'signal', to: peer.id, description: pc.localDescription.toJSON() });
      }
      await this._applySenders(peer);
      if (peer.renegotiate && pc.signalingState === 'stable') {
        peer.renegotiate = false;
        await this._offer(peer);
      }
    } else if (message.candidate && !peer.ignoreOffer) {
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
      else peer.candidates.push(message.candidate);
    }
  }

  _codecPreference(peer) {
    const preference = this.settings.codec;
    const transceiver = peer.transceivers[0];
    if (!transceiver?.setCodecPreferences || !RTCRtpSender.getCapabilities) return;
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
    const chosen = codecs.filter(codec => codec.mimeType.toLowerCase() === preference.toLowerCase());
    if (preference === 'auto') transceiver.setCodecPreferences([]);
    else if (chosen.length) {
      transceiver.setCodecPreferences([...chosen, ...codecs.filter(codec => !chosen.includes(codec))]);
    } else this._emit('status', { state: 'codec-fallback', message: `${preference.replace('video/', '')} is unavailable on this device. Using the browser’s available codecs.` });
  }

  async _applyScreenCodec(peer, sender) {
    if (peer.legacyCodecSelection) return;
    const capture = sender.track?.getSettings() || {};
    const plan = peer.adaptation || adaptiveProfile(this.settings, capture);
    const capabilities = globalThis.navigator?.mediaCapabilities;
    const selected = await chooseScreenCodec(sender.getParameters().codecs || [], {
      preference: this.settings.codec, fps: plan.fps, bitrate: plan.maxBitrate ? plan.maxBitrate / 1e6 : 0,
      width: plan.width, height: plan.height,
      probe: capabilities?.encodingInfo ? configuration => capabilities.encodingInfo(configuration) : null,
      cache: this._codecHints,
    });
    if (this._closed || peer.dropped || peer.pc.signalingState !== 'stable') return;
    // getParameters must be fresh after the asynchronous capability queries.
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    const current = selected && parameters.codecs.find(codec => codecKey(codec) === codecKey(selected));
    if (selected && !current) return;
    if (parameters.encodings.every(encoding => codecKey(encoding.codec) === codecKey(current))) return;
    for (const encoding of parameters.encodings) {
      if (current) encoding.codec = { mimeType: current.mimeType, clockRate: current.clockRate, ...(current.sdpFmtpLine ? { sdpFmtpLine: current.sdpFmtpLine } : {}) };
      else delete encoding.codec;
    }
    try {
      await sender.setParameters(parameters);
      const applied = sender.getParameters().encodings;
      if (current && !applied.every(encoding => codecKey(encoding.codec) === codecKey(current))) throw new Error('This browser did not accept explicit codec selection.');
    } catch (error) {
      peer.legacyCodecSelection = true;
      this._emit('status', { state: 'codec-selection-fallback', message: `Explicit encoder selection is unavailable on this connection. Using the negotiated browser codec; video details show the actual encoder. ${error.message}` });
    }
  }

  async _applySenders(peer) {
    if (!peer.pc.remoteDescription || peer.pc.signalingState !== 'stable') return;
    for (const slot of [0, 2]) {
      const sender = peer.transceivers[slot]?.sender;
      if (!sender) continue;
      if (!sender.track) continue;
      const plan = slot === 0 ? peer.adaptation || adaptiveProfile(this.settings, sender.track.getSettings()) : null;
      const apply = async preference => {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return;
        for (const encoding of parameters.encodings) {
          encoding.maxFramerate = slot === 0 ? plan.fps : this.settings.mode === 'source' ? 30 : 24;
          encoding.scaleResolutionDownBy = slot === 0 ? plan.scale : 1;
          if (slot === 2) encoding.maxBitrate = this.settings.mode === 'source' ? 2e6 : peer.adaptation?.level > 0 ? 350000 : 750000;
          else if (plan.maxBitrate) encoding.maxBitrate = plan.maxBitrate;
          else delete encoding.maxBitrate;
        }
        parameters.degradationPreference = preference;
        await sender.setParameters(parameters);
      };
      try {
        if (slot === 2) await apply('balanced');
        else if (this.settings.mode !== 'source') await apply(this.settings.mode === 'smooth' ? 'maintain-framerate' : 'balanced');
        else if (peer.legacyDegradation) await apply('maintain-framerate');
        else {
          try { await apply('maintain-framerate-and-resolution'); }
          catch (error) {
            if (!['TypeError', 'NotSupportedError'].includes(error.name)) throw error;
            peer.legacyDegradation = true;
            await apply('maintain-framerate');
            this._emit('status', { state: 'quality-fallback', message: 'This browser may reduce resolution to preserve frame rate. Live stats show the delivered quality.' });
          }
        }
        if (slot === 0) await this._applyScreenCodec(peer, sender);
      } catch (error) {
        if (!peer.warnedParameters && !peer.dropped && !this._closed) {
          peer.warnedParameters = true;
          this._emit('error', { message: `The encoder could not apply all quality targets: ${error.message}. Live statistics show the actual result.` });
        }
      }
    }
  }

  async _replaceSlot(slot, track) {
    await Promise.all([...this._peers.values()].map(peer => this._withPeer(peer, async () => {
      // An answerer may still be waiting for the first offer. Its current
      // device tracks will be installed just before creating the answer.
      if (!peer.transceivers[slot]) return;
      await peer.transceivers[slot].sender.replaceTrack(track);
      if (slot === 0 || slot === 2) await this._applySenders(peer);
    })));
  }

  _announceMedia() {
    if (!this.selfId || this._closed) return;
    this._send({ type: 'media', media: {
      camera: Boolean(aliveTrack(this.cameraStream, 'video')),
      microphone: Boolean(aliveTrack(this.microphoneStream, 'audio')),
      ...(!this._screenClaim ? {
        screen: Boolean(aliveTrack(this.screenStream, 'video')),
        systemAudio: Boolean(aliveTrack(this.screenStream, 'audio')),
      } : {}),
    } });
  }

  _emitLocalParticipant() {
    if (!this._localParticipant) this._localParticipant = new MediaStream();
    for (const track of this._localParticipant.getTracks()) this._localParticipant.removeTrack(track);
    const camera = aliveTrack(this.cameraStream, 'video');
    const microphone = aliveTrack(this.microphoneStream, 'audio');
    if (camera) this._localParticipant.addTrack(camera);
    if (microphone) this._localParticipant.addTrack(microphone);
    this._emit('participant-stream', { peerId: this.selfId, stream: this._localParticipant });
  }

  async _constrainScreen(track) {
    track.contentHint = 'motion';
    const height = this.settings.resolution;
    const capabilities = track.getCapabilities?.() || {};
    const sourceHeight = capabilities.height?.max;
    const sourceWidth = capabilities.width?.max;
    const heightLimit = height === 0 ? sourceHeight || track.getSettings().height : Number.isFinite(sourceHeight) && sourceHeight > 0 ? Math.min(height, sourceHeight) : height;
    const requestedWidth = height === 0 ? sourceWidth || track.getSettings().width : Math.round(height * 16 / 9);
    const widthLimit = Number.isFinite(sourceWidth) && sourceWidth > 0 ? Math.min(requestedWidth, sourceWidth) : requestedWidth;
    try {
      await track.applyConstraints({
        frameRate: { ideal: this.settings.fps, max: this.settings.fps },
        height: { ideal: heightLimit, max: heightLimit },
        width: { ideal: widthLimit, max: widthLimit },
      });
    } catch (error) {
      this._emit('error', { message: `The capture source could not apply every quality target: ${error.message}. Sharing continues at the source’s supported settings.` });
    }
  }

  async setScreen(stream) {
    this._assertActive();
    const revision = ++this._screenRevision;
    if (!stream && this._screenClaim) {
      clearTimeout(this._screenClaim.timer); this._screenClaim.reject(new Error('Screen sharing cancelled.')); this._screenClaim = null;
      this._send({ type: 'screen-release' });
    }
    const video = aliveTrack(stream, 'video');
    if (stream && !video) { stopStream(stream); throw new Error('The selected source has no live video track.'); }
    let claimed = false;
    if (video) await this._constrainScreen(video);
    if (video && !this.screenStream && revision === this._screenRevision && !this._closed) {
      try { await this._claimScreen(Boolean(aliveTrack(stream, 'audio'))); claimed = true; }
      catch (error) { stopStream(stream); throw error; }
    }
    if (revision !== this._screenRevision || this._closed || (video && video.readyState !== 'live')) {
      if (claimed && !this.screenStream) this._send({ type: 'screen-release' });
      stopStream(stream); return;
    }
    const previous = this.screenStream;
    this.screenStream = stream;
    for (const peer of this._peers.values()) { peer.adaptation = null; peer.lossSamples = new Map(); peer.startBitrateKbps = null; }
    // Stop capture immediately even if sender renegotiation is still queued.
    if (!stream) stopStream(previous);
    const audio = aliveTrack(stream, 'audio');
    if (audio) {
      try { audio.contentHint = 'music'; } catch { /* Optional hint. */ }
      audio.addEventListener('ended', () => {
        if (this.screenStream === stream && !this._closed) this._announceMedia();
      }, { once: true });
    }
    if (video) video.addEventListener('ended', () => {
      if (this.screenStream === stream && !this._closed) void this.setScreen(null).catch(error => this._error(error));
    }, { once: true });
    try { await Promise.all([this._replaceSlot(0, video), this._replaceSlot(1, audio)]); }
    catch (error) {
      if (this.screenStream === stream) {
        this.screenStream = null; stopStream(stream); stopStream(previous);
        this._send({ type: 'screen-release' });
        await Promise.allSettled([this._replaceSlot(0, null), this._replaceSlot(1, null)]);
        this._emit('screen', { peerId: this.selfId, stream: null });
      }
      throw error;
    }
    if (previous !== stream) stopStream(previous);
    if (this._closed) { stopStream(stream); return; }
    if (revision !== this._screenRevision) return;
    this._announceMedia();
    this._emit('screen', { peerId: this.selfId, stream });
  }

  _claimScreen(systemAudio) {
    if (this._screenClaim) return Promise.reject(new Error('Screen sharing is already starting.'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this._screenClaim = null; this._send({ type: 'screen-release' });
        reject(new Error('Screen sharing could not be reserved. Update the room server and all participants to the latest version.'));
      }, 10000);
      this._screenClaim = { id, timer, resolve, reject };
      if (!this._send({ type: 'screen-claim', requestId: id, systemAudio })) {
        clearTimeout(timer); this._screenClaim = null; reject(new Error('The room connection is unavailable.'));
      }
    });
  }

  setCamera(enabled) { return this._setDevice('camera', Boolean(enabled)); }
  setMicrophone(enabled) { return this._setDevice('microphone', Boolean(enabled)); }

  async _setDevice(kind, enabled) {
    this._assertActive();
    const field = kind === 'camera' ? 'cameraStream' : 'microphoneStream';
    const revisionField = kind === 'camera' ? '_cameraRevision' : '_microphoneRevision';
    const slot = kind === 'camera' ? 2 : 3;
    const revision = ++this[revisionField];
    if (enabled && aliveTrack(this[field], kind === 'camera' ? 'video' : 'audio')) return;
    let stream = null;
    if (enabled) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone access need the desktop app, localhost, or an HTTPS meeting address.');
      try {
        stream = await navigator.mediaDevices.getUserMedia(kind === 'camera'
          ? { audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } } }
          : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (error) { throw new Error(friendlyMediaError(error, kind === 'camera' ? 'Camera' : 'Microphone')); }
    }
    if (this[revisionField] !== revision || this._closed) { stopStream(stream); return; }
    const previous = this[field];
    this[field] = stream;
    const track = stream?.getTracks()[0] || null;
    if (track) track.addEventListener('ended', () => {
      if (this[field] === stream && !this._closed) void this._setDevice(kind, false).catch(error => this._error(error));
    }, { once: true });
    await this._replaceSlot(slot, track);
    stopStream(previous);
    if (this._closed) { stopStream(stream); return; }
    if (this[revisionField] !== revision) return;
    this._announceMedia();
    this._emitLocalParticipant();
  }

  updateSettings(settings) {
    const next = normalizeSettings({ ...(this._requestedSettings || this.settings), ...settings });
    this._requestedSettings = next;
    const operation = (this._settingsQueue || Promise.resolve()).then(async () => {
      if (this._closed) return null;
      const previous = this.settings;
      this.settings = next;
      for (const peer of this._peers.values()) { peer.adaptation = null; peer.lossSamples = new Map(); peer.startBitrateKbps = null; }
      const video = aliveTrack(this.screenStream, 'video');
      if (video) await this._constrainScreen(video);
      await Promise.all([...this._peers.values()].map(peer => this._withPeer(peer, async () => {
        if (previous.codec !== this.settings.codec) {
          this._codecPreference(peer);
          await this._offer(peer);
        }
        await this._applySenders(peer);
      })));
      return video?.getSettings() || null;
    });
    this._settingsQueue = operation.catch(() => {});
    return operation;
  }

  sendChat(text) {
    this._assertActive();
    const message = String(text || '').trim().slice(0, 2000);
    if (message) this._send({ type: 'chat', text: message });
  }

  async _collectStats() {
    if (this._statsBusy || this._closed) return;
    this._statsBusy = true;
    try {
      const sending = !!aliveTrack(this.screenStream, 'video');
      const screenTrack = aliveTrack(this.screenStream, 'video');
      const presenterId = this.members.find(member => member.media?.screen)?.id || null;
      const screenActive = sending || !!presenterId;
      const values = [], roundTrips = [], sourceRates = [], peerStats = [];
      for (const peer of this._peers.values()) {
        if (peer.dropped) continue;
        const relevant = sending || peer.id === presenterId;
        const detail = {
          id: peer.id, name: this.members.find(member => member.id === peer.id)?.name || 'Participant',
          connection: peer.pc.connectionState, ice: peer.pc.iceConnectionState,
          retries: peer.restartCount || 0,
          screen: relevant, fps: null, sourceFps: null, sentFps: null, receivedFps: null,
          codec: null, implementation: null, encodeMs: null, decodeMs: null,
          availableMbps: null, rtt: null, route: null, limitation: null,
        };
        peerStats.push(detail);
        // A failed/new peer can retain zero-valued RTP objects. It must not
        // force a healthy viewer's measured FPS to zero or supply stale RTT.
        if (!screenActive || !relevant || peer.pc.connectionState !== 'connected') {
          for (const key of this._samples.keys()) if (key.startsWith(`${peer.id}:`)) this._samples.delete(key);
          continue;
        }
        const pcStats = await peer.pc.getStats();
        let loss = null;
        let pair;
        pcStats.forEach(report => {
          if (report.type === 'transport' && report.selectedCandidatePairId) pair = pcStats.get(report.selectedCandidatePairId);
        });
        if (!pair) pcStats.forEach(report => {
          if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') pair = report;
        });
        if (Number.isFinite(pair?.currentRoundTripTime)) {
          detail.rtt = pair.currentRoundTripTime * 1000; roundTrips.push(detail.rtt);
        }
        if (Number.isFinite(pair?.availableOutgoingBitrate)) detail.availableMbps = pair.availableOutgoingBitrate / 1e6;
        const local = pcStats.get(pair?.localCandidateId), remote = pcStats.get(pair?.remoteCandidateId);
        const privateIp = address => /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address || '');
        if (local || remote) detail.route = `${local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : privateIp(local?.address) || privateIp(remote?.address) ? 'private network' : 'direct'} ${(local?.protocol || remote?.protocol || '').toUpperCase()}`.trim();
        if (!peer.transceivers[0]) continue;
        const mid = peer.transceivers[0].mid;
        const source = sending ? peer.transceivers[0].sender : peer.transceivers[0].receiver;
        const stats = await source.getStats();
        if (sending) {
          peer.lossSamples ||= new Map();
          pcStats.forEach(report => {
            if (report.type !== 'remote-inbound-rtp' || (report.kind || report.mediaType) !== 'video') return;
            const outbound = stats.get(report.localId);
            if (outbound?.type !== 'outbound-rtp' || (mid !== null && outbound.mid !== undefined && outbound.mid !== mid)) return;
            if (screenTrack?.id && pcStats.get(outbound.mediaSourceId)?.trackIdentifier
              && pcStats.get(outbound.mediaSourceId).trackIdentifier !== screenTrack.id) return;
            const old = peer.lossSamples.get(report.id);
            const lost = old ? report.packetsLost - old.lost : 0;
            const sent = old ? outbound.packetsSent - old.sent : 0;
            if (old && report.timestamp > old.timestamp && report.timestamp - old.timestamp < 5000 && lost >= 0 && sent > 0) loss = Math.min(1, lost / sent);
            peer.lossSamples.set(report.id, { lost: report.packetsLost, sent: outbound.packetsSent, timestamp: report.timestamp });
          });
        }
        stats.forEach(report => {
          if (report.type !== (sending ? 'outbound-rtp' : 'inbound-rtp')) return;
          if ((report.kind || report.mediaType) !== 'video' || report.isRemote || report.active === false) return;
          if (mid !== null && report.mid !== undefined && report.mid !== mid) return;
          const mediaSource = pcStats.get(report.mediaSourceId) || stats.get(report.mediaSourceId);
          if (sending && mediaSource?.trackIdentifier && screenTrack?.id && mediaSource.trackIdentifier !== screenTrack.id) return;
          const key = `${peer.id}:${report.id}`;
          const previous = this._samples.get(key);
          const old = previous?.mediaSourceId === report.mediaSourceId ? previous : null;
          const frames = sending ? report.framesEncoded : report.framesDecoded;
          const bytes = sending ? report.bytesSent : report.bytesReceived;
          const seconds = old ? (report.timestamp - old.timestamp) / 1000 : 0;
          const fps = seconds > 0 && Number.isFinite(frames) && Number.isFinite(old.frames)
            ? Math.max(0, (frames - old.frames) / seconds)
            : Number.isFinite(report.framesPerSecond) ? report.framesPerSecond : null;
          const bitrate = seconds > 0 && Number.isFinite(bytes) && Number.isFinite(old.bytes)
            ? Math.max(0, (bytes - old.bytes) * 8 / seconds / 1e6) : null;
          const delta = (current, previous) => seconds > 0 && Number.isFinite(current) && Number.isFinite(previous) ? Math.max(0, (current - previous) / seconds) : null;
          const sourceSeconds = old && mediaSource ? (mediaSource.timestamp - old.sourceTimestamp) / 1000 : 0;
          const sourceFps = sourceSeconds > 0 && Number.isFinite(mediaSource?.frames) && Number.isFinite(old.sourceFrames)
            ? Math.max(0, (mediaSource.frames - old.sourceFrames) / sourceSeconds)
            : Number.isFinite(mediaSource?.framesPerSecond) ? mediaSource.framesPerSecond : null;
          const sentFps = delta(report.framesSent, old?.framesSent);
          const receivedFps = delta(report.framesReceived, old?.framesReceived);
          const frameDelta = old && Number.isFinite(frames) ? frames - old.frames : 0;
          const frameTime = sending ? report.totalEncodeTime : report.totalDecodeTime;
          const workMs = frameDelta > 0 && Number.isFinite(frameTime) && Number.isFinite(old?.workTime) ? Math.max(0, (frameTime - old.workTime) * 1000 / frameDelta) : null;
          const codec = pcStats.get(report.codecId) || stats.get(report.codecId);
          this._samples.set(key, { frames, bytes, timestamp: report.timestamp, framesSent: report.framesSent, framesReceived: report.framesReceived, sourceFrames: mediaSource?.frames, sourceTimestamp: mediaSource?.timestamp, workTime: frameTime, mediaSourceId: report.mediaSourceId });
          if (sourceFps !== null) sourceRates.push(sourceFps);
          Object.assign(detail, {
            fps, sourceFps, sentFps, receivedFps, codec: codec?.mimeType?.replace('video/', '') || null,
            implementation: sending ? report.encoderImplementation || null : report.decoderImplementation || null,
            powerEfficient: sending ? report.powerEfficientEncoder ?? null : report.powerEfficientDecoder ?? null,
            resolution: report.frameWidth && report.frameHeight ? `${report.frameWidth} × ${report.frameHeight}` : null,
            encodeMs: sending ? workMs : null, decodeMs: sending ? null : workMs,
            limitation: report.qualityLimitationReason || null,
          });
          values.push({ fps, bitrate, sourceFps, sentFps, receivedFps, width: report.frameWidth, height: report.frameHeight, limitation: report.qualityLimitationReason });
        });
        if (sending && detail.fps !== null) {
          const previous = peer.adaptation;
          peer.adaptation = adaptiveProfile(this.settings, screenTrack.getSettings(), { ...detail, loss }, previous || {});
          detail.adaptation = { mode: this.settings.mode, level: peer.adaptation.level,
            targetFps: peer.adaptation.fps, height: peer.adaptation.height };
          if (previous && (previous.level !== peer.adaptation.level || previous.maxBitrate !== peer.adaptation.maxBitrate)) {
            await this._withPeer(peer, () => this._applySenders(peer));
            this._emit('adaptation', { peerId: peer.id, name: detail.name, ...detail.adaptation });
          }
        }
      }
      if (this._closed) return;
      const frames = values.map(value => value.fps).filter(Number.isFinite);
      const rates = values.map(value => value.bitrate).filter(Number.isFinite);
      const dimensions = values.find(value => value.width && value.height);
      const capture = screenTrack?.getSettings();
      const fps = frames.length ? Math.round(Math.min(...frames) * 10) / 10 : null;
      const sourceFps = sourceRates.length ? Math.round(Math.min(...sourceRates) * 10) / 10 : null;
      const connectedPeers = peerStats.filter(peer => peer.screen && peer.connection === 'connected');
      const failedPeers = peerStats.filter(peer => peer.screen && ['failed', 'disconnected'].includes(peer.connection)).length;
      const turnConfigured = (this._iceServers || []).some(server => [].concat(server.urls || []).some(url => /^turns?:/i.test(url)));
      let videoState = !screenActive ? 'not-sharing' : !peerStats.some(peer => peer.screen) ? 'waiting-peer' : !connectedPeers.length ? 'media-unavailable' : fps === null ? 'starting' : fps > 0.5 ? 'active' : 'no-new-frames';
      if (videoState === 'no-new-frames' && sending && sourceFps > 0.5) videoState = 'encoder-stalled';
      if (videoState === 'no-new-frames' && !sending && values.some(value => value.receivedFps > 0.5)) videoState = 'decoder-stalled';
      this._emit('stats', {
        recovering: [...this._peers.values()].some(peer => !!peer.retryTimer || !!peer.retryWatchdog),
        fps, sourceFps, videoState, failedPeers, turnConfigured, peerStats,
        bitrate: rates.length ? Math.round(rates.reduce((total, value) => total + value, 0) * 100) / 100 : null,
        rtt: roundTrips.length ? Math.round(roundTrips.reduce((total, value) => total + value, 0) / roundTrips.length) : null,
        resolution: dimensions ? `${dimensions.width} × ${dimensions.height}` : capture?.width ? `${capture.width} × ${capture.height}` : null,
        resolutionKind: dimensions ? (sending ? 'encoded' : 'decoded') : 'capture',
        target: sending ? this.settings.fps : null,
        kind: sending ? 'sending' : 'receiving',
        peers: connectedPeers.length,
        limitation: values.find(value => value.limitation && value.limitation !== 'none')?.limitation || null,
      });
    } catch (error) {
      if (!this._closed && error?.name !== 'InvalidStateError') this._emit('status', { state: 'stats-unavailable', message: 'Some stream statistics are temporarily unavailable.' });
    } finally { this._statsBusy = false; }
  }

  _dropPeer(peer) {
    this._clearMediaRetry(peer);
    peer.dropped = true;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    stopStream(peer.screen);
    stopStream(peer.participant);
    for (const key of this._samples.keys()) if (key.startsWith(`${peer.id}:`)) this._samples.delete(key);
  }

  close() { this._shutdown('left', 'You left the meeting.'); }

  _shutdown(reason, message) {
    if (this._closed) return;
    this._closed = true;
    ++this._screenRevision;
    ++this._cameraRevision;
    ++this._microphoneRevision;
    clearInterval(this._statsTimer);
    globalThis.removeEventListener?.('online', this._onNetworkOnline);
    if (this._screenClaim) {
      clearTimeout(this._screenClaim.timer); this._screenClaim.reject(new Error(message)); this._screenClaim = null;
    }
    if (this._pendingWelcome) {
      clearTimeout(this._pendingWelcome.timer);
      this._pendingWelcome.reject(new Error(message));
      this._pendingWelcome = null;
    }
    for (const peer of this._peers.values()) this._dropPeer(peer);
    this._peers.clear();
    this._samples.clear();
    this._codecHints.clear();
    stopStream(this.screenStream);
    stopStream(this.cameraStream);
    stopStream(this.microphoneStream);
    this.screenStream = this.cameraStream = this.microphoneStream = null;
    if (this._socket) {
      this._socket.onopen = this._socket.onmessage = this._socket.onerror = this._socket.onclose = null;
      if (this._socket.readyState < WebSocket.CLOSING) this._socket.close(1000, 'Leaving meeting');
    }
    if (!this._ended) {
      this._ended = true;
      this._emit('ended', { reason, message });
    }
  }
}

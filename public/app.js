import { MeetingEngine } from './engine.js';
import { DeviceFeedback } from './feedback.js';

const $ = id => document.getElementById(id);
let meeting = null, busy = false, captureBusy = false, nativeInfo = null, configuration = {};
let currentMembers = [], stageOwner = null, toastTimer;
let sourceDetails = null, lastStats = null, internetState = { state: 'off', url: null };
let activeInvitation = null, queuedInvitation = null, initialized = false;
const participantStreams = new Map();
const deviceBusy = new Set();
const desktop = window.togetherDesktop;
desktop?.onInvitation?.(invitation => { if (initialized) applyInvitation(invitation); else queuedInvitation = invitation; });
const feedback = new DeviceFeedback(() => $('feedback-mode').value);
document.querySelector('label[for="fps"]').textContent = 'FRAME RATE TARGET';
$('internet-note').textContent = 'Your PC hosts the room. The free public tunnel uses no account or paid fallback. If the provider refuses free access, internet sharing stops with an explanation. Your internet data allowance applies.';
$('resolution').prepend(new Option('Original / source resolution', '0', true, true));
$('bitrate').prepend(new Option('Automatic · best available', '0', true, true));
const saved = {
  get(key, fallback = '') { try { return localStorage.getItem(`together.${key}`) || fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`together.${key}`, value); } catch {} },
};

function settings() {
  return { fps: +$('fps').value, resolution: +$('resolution').value, bitrate: +$('bitrate').value, codec: $('codec').value };
}
function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-error', error);
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function safeServer(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Enter a complete server address, such as https://together.example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTP or HTTPS server origin without a path or password.');
  return url.origin;
}
function parseCode(raw) {
  const value = raw.trim();
  if (!value) throw new Error('Paste the meeting code or invite link first.');
  const shortCode = /^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/i;
  if (value.startsWith('together-watch:')) {
    const link = new URL(value);
    const code = link.searchParams.get('code');
    if (link.hostname !== 'join' || !['', '/'].includes(link.pathname) || link.username || link.password || link.hash || !shortCode.test(code || '')) throw new Error('That app invitation is invalid.');
    return { code, server: safeServer(link.searchParams.get('server')) };
  }
  if (shortCode.test(value)) return { code: value, server: safeServer($('server-url').value.trim()) };
  let text = value;
  if (!/^https?:\/\//i.test(text)) {
    const host = text.split('/')[0];
    text = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ? 'http://' : 'https://') + text;
  }
  try {
    const url = new URL(text);
    const code = new URLSearchParams(url.hash.slice(1)).get('code') || decodeURIComponent(url.pathname.slice(1));
    if (!shortCode.test(code)) throw new Error();
    return { code, server: safeServer(url.origin) };
  } catch { throw new Error('That code is incomplete. Paste the full code or invite link from your host.'); }
}
function invitationOrigin() {
  const selected = safeServer($('server-url').value.trim());
  if (nativeInfo && selected === nativeInfo.localOrigin) return internetState.url || configuration.publicUrl || nativeInfo.lanOrigin;
  return selected;
}
function portableCode() {
  const address = invitationOrigin().replace(/^http:\/\//, '');
  return `${address}/#code=${encodeURIComponent(meeting.code)}`;
}
function inviteLink() { return `${invitationOrigin()}/?open=app#code=${encodeURIComponent(meeting.code)}`; }
function appLink(invitation = { server: invitationOrigin(), code: meeting.code }) {
  const link = new URL('together-watch://join');
  link.searchParams.set('server', invitation.server); link.searchParams.set('code', invitation.code);
  return link.href;
}
function applyInvitation(invitation, autoOpen = false) {
  if (!invitation?.code) return;
  const server = safeServer(invitation.server);
  if (meeting?.selfId || busy) {
    if (meeting?.code === invitation.code) toast('You are already in this room.');
    else { queuedInvitation = { server, code: invitation.code }; message('Leave your current room to join the new invitation.'); }
    return;
  }
  activeInvitation = { server, code: invitation.code, invalid: !/^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/i.test(invitation.code) };
  $('server-url').value = server;
  $('meeting-code').value = `${server}/#code=${encodeURIComponent(invitation.code)}`;
  refreshControls();
  message(activeInvitation.invalid ? 'This invitation has an invalid meeting code.' : `Invitation to ${invitation.code.slice(0, 8)}. Add your name and choose Join this room.` , activeInvitation.invalid);
  if (autoOpen && !desktop && !activeInvitation.invalid) setTimeout(openInvitationInApp, 200);
}
function openInvitationInApp() {
  if (!activeInvitation || activeInvitation.invalid || meeting?.selfId || busy) return;
  const uri = appLink(activeInvitation);
  const event = new CustomEvent('together-open-app', { detail: { uri }, cancelable: true });
  if (window.dispatchEvent(event)) window.location.href = uri;
  message('Opening Together. Approve your browser’s Open app prompt. If nothing happens, run the latest EXE once or join this room below.');
}
function clearInvitation() {
  activeInvitation = queuedInvitation = null;
  $('meeting-code').value = '';
  $('server-url').value = nativeInfo?.localOrigin || location.origin;
  refreshControls(); message('Enter a meeting code, or create a room of your own.');
}
async function copy(text) {
  if (desktop) await desktop.writeClipboard(text);
  else if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
  else {
    // Clipboard API is unavailable on a plain HTTP LAN viewer.
    const input = document.createElement('textarea');
    input.value = text; input.setAttribute('readonly', ''); document.body.append(input); input.select();
    const ok = document.execCommand('copy'); input.remove();
    if (!ok) throw new Error('Copy is unavailable here. Select the meeting code and copy it manually.');
  }
  toast('Copied. Send it to your people.');
}
function resetMetrics() {
  for (const id of ['stat-fps', 'stat-bitrate', 'stat-latency', 'stat-resolution']) $(id).textContent = '—';
  $('stat-target').textContent = `${$('fps').value} FPS target`;
  $('video-health').textContent = 'Video measurements appear after a viewer connects.';
  $('video-health').classList.remove('warning');
  $('media-diagnostics').textContent = 'No active media connection.';
}
function showVideoHealth(data) {
  const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : '—';
  const states = {
    'not-sharing': 'The host is not sharing a screen.',
    'waiting-peer': 'Waiting for a viewer. Local preview is not a transmitted video stream.',
    'media-unavailable': `Participants have joined, but the screen media path is not connected.${data.turnConfigured ? ' Check the relay and network connection.' : ' TURN is not configured; restrictive networks may require a relay.'}`,
    'starting': 'Media is connected. Waiting for video-frame measurements.',
    'no-new-frames': 'No new video frames in this sample. The source may be static/paused, or video capture may be stalled.',
    'encoder-stalled': 'Capture is supplying frames, but no new video frames are being encoded. Check encoder/connection details below.',
    'decoder-stalled': 'Video frames are arriving, but the viewer is not decoding new frames. Check codec, decoder, and packet delivery.',
  };
  let text = states[data.videoState] || (data.kind === 'sending'
    ? `Capture input: ${round(data.sourceFps)} FPS → encoded stream: ${round(data.fps)} FPS.`
    : `Decoded on this viewer: ${round(data.fps)} FPS.`);
  if (data.failedPeers) text += ` ${data.failedPeers} failed/disconnected participant connection(s) are excluded from the FPS counter.`;
  $('video-health').textContent = text;
  $('video-health').classList.toggle('warning', ['media-unavailable', 'encoder-stalled', 'decoder-stalled'].includes(data.videoState) || !!data.failedPeers);
  const lines = [`TURN relay: ${data.turnConfigured ? 'configured' : 'not configured'}`];
  for (const peer of data.peerStats || []) {
    lines.push(`\n${peer.name}: ${peer.connection}${peer.route ? ` · ${peer.route}` : ''}`);
    if (!peer.screen || peer.connection !== 'connected') continue;
    lines.push(data.kind === 'sending'
      ? `Capture input ${round(peer.sourceFps)} FPS | encoded ${round(peer.fps)} FPS | sent ${round(peer.sentFps)} FPS`
      : `Received ${round(peer.receivedFps)} FPS | decoded ${round(peer.fps)} FPS`);
    lines.push(`Stream resolution ${peer.resolution || '—'}`);
    lines.push(`Codec ${peer.codec || '—'} | ${peer.implementation || 'implementation unavailable'}${peer.powerEfficient == null ? '' : ` | ${peer.powerEfficient ? 'hardware / power efficient' : 'software / not power efficient'}`}`);
    lines.push(`Frame processing ${round(data.kind === 'sending' ? peer.encodeMs : peer.decodeMs)} ms | RTT ${round(peer.rtt)} ms${data.kind === 'sending' ? ` | available send estimate ${round(peer.availableMbps)} Mbps` : ''}`);
    if (peer.limitation && peer.limitation !== 'none') lines.push(`Reported limit: ${peer.limitation}`);
  }
  $('media-diagnostics').textContent = lines.join('\n');
}
function updateNetwork() {
  const active = !!meeting?.selfId;
  const local = !!nativeInfo && $('server-url').value.replace(/\/$/, '') === nativeInfo.localOrigin;
  const working = internetState.state === 'starting';
  const online = internetState.state === 'online';
  $('start-internet').hidden = !desktop || online;
  $('start-internet').disabled = working || busy || !!activeInvitation || (active && (!local || meeting.role !== 'host'));
  $('start-internet').textContent = working ? 'Creating public address…' : 'Start internet room · free';
  $('stop-internet').hidden = !desktop || (!online && !working);
  $('stop-internet').textContent = working ? 'Cancel internet setup' : 'Stop public address';
  $('internet-note').hidden = !desktop;
  let address = $('server-url').value;
  try { address = invitationOrigin(); } catch {}
  const privateAddress = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(address);
  $('reachability-badge').textContent = working ? 'Preparing internet access' : privateAddress ? 'Local network only' : 'Internet server address';
  $('reachability-note').textContent = working
    ? 'Your existing local room stays connected while a public address is created.'
    : privateAddress
      ? 'This code works on the same LAN or VPN. For friends in another place, choose Start internet room, then copy the NEW code.'
      : `Friends elsewhere can join with the full code. Keep this PC and Together running.${online ? ' Stopping the public address disconnects internet guests.' : ''}`;
  if (internetState.error) $('reachability-note').textContent = internetState.error;
}
function updateQuality(capture) {
  if (meeting?.role === 'guest') {
    $('quality-summary').textContent = lastStats?.resolution
      ? `Receiving: ${lastStats.resolution}${lastStats.fps == null ? '' : ` · ${Math.round(lastStats.fps)} FPS`}\nThe host controls screen quality. Fullscreen changes display size, not source detail.`
      : 'Waiting for the host’s stream. The host controls screen quality.';
    $('quality-summary').classList.remove('limited');
    return;
  }
  const track = meeting?.screenStream?.getVideoTracks()[0];
  const actual = capture || track?.getSettings();
  const target = settings();
  const parts = [target.resolution === 0 ? `Original/source resolution · ${target.fps} FPS target` : `Target: up to ${Math.round(target.resolution * 16 / 9)} × ${target.resolution} · ${target.fps} FPS`];
  parts.push(target.bitrate === 0 ? 'Bandwidth: automatic, best available' : `Bandwidth limit: ${target.bitrate} Mbps per viewer`);
  let limited = false;
  if (actual?.width) {
    parts.push(`Capture: ${actual.width} × ${actual.height} · up to ${Math.round(actual.frameRate || 0)} FPS reported`);
    const capabilities = track?.getCapabilities?.() || {};
    const sourceHeight = sourceDetails?.height || capabilities.height?.max || actual.height;
    if (sourceHeight < target.resolution - 2) {
      limited = true;
      parts.push(`Your source is only ${sourceHeight} pixels high. ${target.resolution === 2160 ? 'True 4K needs a 4K source; ' : ''}upscaling cannot add detail.`);
    }
    parts.push(lastStats?.fps == null ? 'No viewer samples yet. Encoded FPS and bitrate appear after a viewer connects.' : `Live stream: ${lastStats.resolution || 'measuring'} · ${Math.round(lastStats.fps)} FPS`);
  } else parts.push('Choose Entire screen to capture all apps on a monitor, or choose one window.');
  $('quality-summary').textContent = parts.join('\n');
  $('quality-summary').classList.toggle('limited', limited);
}
function refreshControls() {
  const active = !!meeting?.selfId;
  $('room-entry').hidden = active;
  $('room-active').hidden = !active;
  $('create-room').disabled = busy || !!activeInvitation;
  $('create-room').hidden = !!activeInvitation;
  document.querySelector('.or-divider').hidden = !!activeInvitation;
  $('join-room').disabled = busy || !!activeInvitation?.invalid;
  $('join-room').textContent = activeInvitation ? 'Join this room' : 'Join';
  $('invitation-panel').hidden = !activeInvitation;
  $('open-in-app').hidden = !!desktop;
  $('app-link-note').hidden = !!desktop;
  $('copy-app-link').hidden = !active;
  if (activeInvitation) {
    $('invitation-title').textContent = `Join room ${activeInvitation.code.slice(0, 8)}`;
    $('invitation-server').textContent = `Room server: ${new URL(activeInvitation.server).host}`;
  }
  $('server-url').disabled = active || busy || !!activeInvitation;
  $('display-name').disabled = active || busy;
  $('toggle-mic').disabled = !active || deviceBusy.has('microphone');
  $('toggle-camera').disabled = !active || deviceBusy.has('camera');
  $('share-screen').disabled = !active || meeting?.role !== 'host' || captureBusy;
  $('share-screen').textContent = meeting?.screenStream ? 'Stop sharing' : 'Share screen';
  $('toggle-mic').textContent = meeting?.microphoneStream ? 'Mute microphone' : 'Turn on microphone';
  $('toggle-camera').textContent = meeting?.cameraStream ? 'Turn off camera' : 'Turn on camera';
  $('toggle-mic').setAttribute('aria-pressed', String(!!meeting?.microphoneStream));
  $('toggle-camera').setAttribute('aria-pressed', String(!!meeting?.cameraStream));
  $('share-screen').setAttribute('aria-pressed', String(!!meeting?.screenStream));
  $('system-audio').disabled = captureBusy || !!meeting?.screenStream || (active && meeting.role !== 'host');
  for (const id of ['fps', 'resolution', 'bitrate', 'codec']) $(id).disabled = active && meeting.role !== 'host';
  // A viewer's saved local defaults are not the host's quality targets.
  document.querySelector('.settings-grid').hidden = active && meeting.role !== 'host';
  $('chat-input').disabled = !active;
  $('chat-form').querySelector('button').disabled = !active;
  $('connection-status').textContent = active ? 'Room connected' : busy ? 'Connecting…' : 'Ready when you are';
  $('connection-status').classList.toggle('connected', active);
  if (active) {
    $('room-code').textContent = portableCode();
    $('room-title').textContent = `${meeting.code.split('-')[0]} · ${meeting.role === 'host' ? 'Your room' : 'Watching together'}`;
  } else {
    $('room-title').textContent = 'Your next watch party';
  }
  $('member-count').textContent = `${currentMembers.length} / ${configuration.maxMembers || 6}`;
  updateNetwork();
  renderParticipants();
}
function attemptPlayback(video) {
  const result = video.play();
  result?.catch(error => { if (error.name === 'NotAllowedError') $('enable-audio').hidden = false; });
}
function setStage(peerId, stream) {
  if (stream) stageOwner = peerId;
  const video = $('screen-video');
  video.srcObject = stream || null;
  video.muted = peerId === meeting?.selfId;
  if (stream) attemptPlayback(video);
  renderStage();
}
function renderStage() {
  const sharing = currentMembers.find(member => member.id === stageOwner && member.media?.screen);
  const live = !!sharing && !!$('screen-video').srcObject;
  $('screen-video').hidden = !live;
  $('stage-empty').hidden = live;
  $('stage-caption').textContent = live ? `${sharing.name}${sharing.id === meeting?.selfId ? ' (you)' : ''} is sharing` : meeting?.selfId ? 'Waiting for the host to share' : 'A little closer, wherever you are';
  if (!live) resetMetrics();
}
function renderParticipants() {
  const container = $('participants');
  for (const element of [...container.children]) if (!currentMembers.some(m => m.id === element.dataset.peerId)) {
    for (const media of element.querySelectorAll('video, audio')) { media.pause(); media.srcObject = null; }
    element.remove();
  }
  for (const member of currentMembers) {
    let tile = [...container.children].find(element => element.dataset.peerId === member.id);
    if (!tile) {
      tile = document.createElement('article'); tile.className = 'participant-tile'; tile.dataset.peerId = member.id;
      const video = document.createElement('video'); video.autoplay = true; video.playsInline = true;
      video.muted = true;
      // A silent camera track can wait forever for its first video frame. Play
      // voice on its own audio element so talking works with the camera off.
      const voice = document.createElement('audio'); voice.autoplay = true;
      const avatar = document.createElement('div'); avatar.className = 'participant-avatar';
      const label = document.createElement('div'); label.className = 'participant-label';
      const name = document.createElement('span'); name.className = 'participant-name';
      const audio = document.createElement('span'); audio.className = 'participant-mic';
      label.append(name, audio); tile.append(video, voice, avatar, label); container.append(tile);
    }
    const video = tile.querySelector('video');
    const voice = tile.querySelector('audio');
    const stream = participantStreams.get(member.id);
    voice.muted = member.id === meeting?.selfId || !member.media?.microphone;
    const assign = (element, tracks) => {
      const previous = element.srcObject?.getTracks() || [];
      if (previous.length === tracks.length && previous.every((track, i) => track.id === tracks[i].id)) return;
      element.srcObject = tracks.length ? new MediaStream(tracks) : null;
      if (tracks.length) attemptPlayback(element);
    };
    assign(video, stream?.getVideoTracks() || []);
    assign(voice, stream?.getAudioTracks() || []);
    video.classList.toggle('camera-off', !member.media?.camera);
    tile.querySelector('.participant-avatar').hidden = !!member.media?.camera;
    tile.querySelector('.participant-avatar').textContent = member.name.slice(0, 2).toUpperCase();
    tile.querySelector('.participant-name').textContent = `${member.name}${member.id === meeting?.selfId ? ' (you)' : ''}${member.role === 'host' ? ' · host' : ''}`;
    tile.querySelector('.participant-mic').textContent = member.media?.microphone ? 'Mic on' : 'Muted';
    tile.classList.toggle('mic-on', !!member.media?.microphone);
  }
}
function appendChat(data) {
  const row = document.createElement('li'); row.className = 'chat-message';
  const heading = document.createElement('div'); heading.className = 'chat-message-meta';
  const name = document.createElement('strong'); name.textContent = data.name;
  const time = document.createElement('time'); time.textContent = new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = document.createElement('p'); body.textContent = data.text;
  heading.append(name, time); row.append(heading, body); $('messages').append(row);
  while ($('messages').children.length > 100) $('messages').firstElementChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}
function handleEvent(source, type, data) {
  if (source !== meeting) return;
  switch (type) {
    case 'welcome':
      currentMembers = data.members; busy = false; refreshControls();
      message(data.role === 'host' ? 'Room ready. Copy the meeting code, then choose a screen to share.' : 'You’re in. Turn on your microphone or camera whenever you want.');
      $('settings-note').textContent = data.role === 'host'
        ? 'Frame rate is a requested target. Capture, encoding, network, and viewer decoding determine the delivered FPS.'
        : 'The host controls screen quality. Live stats show the stream this device actually receives.';
      break;
    case 'members':
      currentMembers = data.members; refreshControls(); renderStage(); break;
    case 'screen': setStage(data.peerId, data.stream); updateQuality(); break;
    case 'participant-stream': participantStreams.set(data.peerId, data.stream); renderParticipants(); break;
    case 'chat': appendChat(data); break;
    case 'error': message(data.message, true); break;
    case 'status': message(queuedInvitation && meeting?.selfId ? 'Leave your current room to join the new invitation.' : data.message); break;
    case 'stats':
      lastStats = data;
      $('stat-fps').textContent = data.fps == null ? '—' : `${Math.round(data.fps)} FPS`;
      $('stat-bitrate').textContent = data.bitrate == null ? '—' : `${data.bitrate.toFixed(1)} Mbps`;
      $('stat-latency').textContent = data.rtt == null ? '—' : `${Math.round(data.rtt)} ms RTT`;
      $('stat-resolution').textContent = data.resolution || '—';
      $('resolution-kind').textContent = data.resolutionKind === 'encoded' ? 'encoded resolution' : data.kind === 'receiving' ? 'received resolution' : 'capture resolution';
      $('stat-target').textContent = data.kind === 'sending'
        ? `${data.target} FPS target${data.videoState === 'media-unavailable' ? ' · media disconnected' : data.fps == null ? ' · measuring' : ' · encoded'}${data.peers > 1 ? ' · total bitrate' : ''}`
        : 'Received stream · decoded FPS';
      if (data.limitation && data.limitation !== 'none') $('settings-note').textContent = `The encoder reports a ${data.limitation} constraint. Open Video and connection details to compare capture, encoding, and delivery.`;
      showVideoHealth(data);
      updateQuality();
      break;
    case 'ended':
      currentMembers = []; participantStreams.clear(); busy = false; stageOwner = null; lastStats = null; sourceDetails = null;
      $('screen-video').srcObject = null; $('enable-audio').hidden = true;
      meeting = null; refreshControls(); renderStage(); updateQuality(); message(data.message || 'You left the room.');
      if (queuedInvitation) { const invitation = queuedInvitation; queuedInvitation = null; applyInvitation(invitation); }
      break;
  }
}
async function enterRoom(create) {
  if (busy || meeting?.selfId) return;
  if (create && activeInvitation) { message('This is an invitation. Choose Join this room to meet your host.'); return; }
  busy = true; refreshControls();
  let instance;
  try {
    const name = $('display-name').value.trim();
    if (!name) throw new Error('Add your name first.');
    const parsed = create ? { server: safeServer($('server-url').value.trim()) } : activeInvitation && !activeInvitation.invalid ? activeInvitation : parseCode($('meeting-code').value);
    $('server-url').value = parsed.server;
    saved.set('name', name);
    if (!nativeInfo || parsed.server !== nativeInfo.localOrigin) saved.set('server', parsed.server);
    instance = new MeetingEngine({ serverUrl: parsed.server, name, settings: settings(), onEvent: (type, data) => handleEvent(instance, type, data) });
    meeting = instance;
    $('messages').replaceChildren();
    await (create ? instance.create() : instance.join(parsed.code));
  } catch (error) {
    instance?.close();
    if (meeting === instance) meeting = null;
    message(error.message, true);
  } finally { busy = false; refreshControls(); }
}
async function chooseSource() {
  const sources = await desktop.getSources();
  if (!sources.length) throw new Error('No available screens or windows were found.');
  $('source-list').replaceChildren();
  return new Promise(resolve => {
    const dialog = $('source-dialog');
    const cleanup = result => { dialog.removeEventListener('close', closed); dialog.close(); resolve(result); };
    const closed = () => cleanup(undefined);
    dialog.addEventListener('close', closed, { once: true });
    const render = kind => {
      $('source-list').replaceChildren();
      for (const [id, selected] of [['source-screen-tab', kind === 'screen'], ['source-window-tab', kind === 'window']]) $(id).setAttribute('aria-selected', String(selected));
      $('source-description').textContent = kind === 'screen'
        ? 'Shares the ENTIRE selected monitor: every app, browser, and window visible on it.'
        : 'Shares one application window. To show all apps, switch to Entire screen.';
      for (const source of sources.filter(source => source.kind === kind)) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'source-card'; button.dataset.sourceKind = source.kind;
        const thumbnail = document.createElement('img'); thumbnail.src = source.thumbnail; thumbnail.alt = '';
        const name = document.createElement('span'); name.textContent = `${kind === 'screen' ? 'Entire screen' : 'Window'} · ${source.name}${source.width ? ` · ${source.width} × ${source.height}` : ''}`;
        button.append(thumbnail, name); button.addEventListener('click', () => cleanup(source)); $('source-list').append(button);
      }
    };
    $('source-screen-tab').onclick = () => render('screen');
    $('source-window-tab').onclick = () => render('window');
    render(sources.some(source => source.kind === 'screen') ? 'screen' : 'window');
    dialog.showModal();
  });
}
async function shareScreen() {
  if (!meeting?.selfId || meeting.role !== 'host' || captureBusy) return;
  captureBusy = true; refreshControls();
  const current = meeting;
  let stream;
  try {
    if (current.screenStream) { await current.setScreen(null); setStage(null, null); message('Screen sharing stopped. Camera and voice are still connected.'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen sharing needs the desktop app or an HTTPS browser connection.');
    if (desktop) {
      const source = await chooseSource();
      if (!source) return;
      sourceDetails = source;
      await desktop.selectSource(source.id, $('system-audio').checked);
    }
    const options = settings();
    const videoConstraints = { frameRate: { ideal: options.fps, max: options.fps } };
    if (options.resolution > 0) Object.assign(videoConstraints, {
      height: { ideal: options.resolution, max: options.resolution },
      width: { ideal: Math.round(options.resolution * 16 / 9), max: Math.round(options.resolution * 16 / 9) },
    });
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: $('system-audio').checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false } : false,
      systemAudio: $('system-audio').checked ? 'include' : 'exclude',
      monitorTypeSurfaces: 'include',
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    });
    if (meeting !== current || !current.selfId) { stream.getTracks().forEach(track => track.stop()); return; }
    await current.setScreen(stream);
    const capture = stream.getVideoTracks()[0].getSettings();
    $('settings-note').textContent = `Capture reports ${capture.width || '?'} × ${capture.height || '?'} at up to ${Math.round(capture.frameRate || 0)} FPS. The live counters show actual encoded/decoded frames once a viewer connects.`;
    updateQuality(capture);
    message(`Sharing your screen${stream.getAudioTracks().length ? ' with system audio' : ' without system audio'}. ${options.fps} FPS requested.`);
    if ($('system-audio').checked && !stream.getAudioTracks().length) toast('No system audio track. Choose a screen or a browser tab with audio sharing enabled.');
    if (desktop && stream.getAudioTracks().length && stream.getAudioTracks()[0].getSettings().restrictOwnAudio !== true) {
      message('Sharing with system audio. This device did not confirm exclusion of Together’s own sound; other members may hear an echo. If so, share a browser tab with tab audio in the browser edition.', true);
    }
  } catch (error) {
    if (stream && current.screenStream !== stream) stream.getTracks().forEach(track => track.stop());
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') message(`Could not share: ${error.message}`, true);
    else message('Screen sharing cancelled. Choose Share screen to try again.');
  } finally { captureBusy = false; refreshControls(); }
}
async function toggleDevice(kind) {
  if (!meeting?.selfId || deviceBusy.has(kind)) return;
  deviceBusy.add(kind);
  const button = $(kind === 'camera' ? 'toggle-camera' : 'toggle-mic');
  button.disabled = true;
  feedback.prime();
  const current = meeting;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require the desktop app or HTTPS. Plain HTTP LAN pages can watch only.');
    if (kind === 'camera') await meeting.setCamera(!meeting.cameraStream);
    else await meeting.setMicrophone(!meeting.microphoneStream);
    if (meeting === current) feedback.play(kind, !!(kind === 'camera' ? current.cameraStream : current.microphoneStream));
  } catch (error) { message(`${kind === 'camera' ? 'Camera' : 'Microphone'}: ${error.message}`, true); }
  finally { deviceBusy.delete(kind); refreshControls(); }
}

$('create-room').addEventListener('click', () => enterRoom(true));
$('join-room').addEventListener('click', () => enterRoom(false));
$('meeting-code').addEventListener('keydown', event => { if (event.key === 'Enter') enterRoom(false); });
$('display-name').addEventListener('keydown', event => { if (event.key === 'Enter' && activeInvitation) enterRoom(false); });
$('leave-room').addEventListener('click', () => meeting?.close());
$('share-screen').addEventListener('click', shareScreen);
$('toggle-camera').addEventListener('click', () => toggleDevice('camera'));
$('toggle-mic').addEventListener('click', () => toggleDevice('microphone'));
$('copy-code').addEventListener('click', () => copy(portableCode()).catch(error => message(error.message, true)));
$('copy-link').addEventListener('click', () => copy(inviteLink()).catch(error => message(error.message, true)));
$('copy-app-link').addEventListener('click', () => copy(appLink()).catch(error => message(error.message, true)));
$('open-in-app').addEventListener('click', openInvitationInApp);
$('clear-invitation').addEventListener('click', clearInvitation);
$('meeting-code').addEventListener('input', () => {
  if (!initialized || meeting?.selfId || busy) return;
  if (!$('meeting-code').value.trim()) { clearInvitation(); return; }
  try { applyInvitation(parseCode($('meeting-code').value)); }
  catch { if (activeInvitation) { activeInvitation.invalid = true; refreshControls(); } }
});
async function toggleFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); }
  catch (error) { message(error.message, true); }
}
$('fullscreen').addEventListener('click', toggleFullscreen);
$('screen-video').addEventListener('dblclick', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  const active = !!document.fullscreenElement;
  $('fullscreen').setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
  $('fullscreen').title = active ? 'Exit full screen (Esc)' : 'Full screen (F)';
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.fullscreenElement) {
    event.preventDefault();
    void document.exitFullscreen().catch(error => message(error.message, true));
    return;
  }
  if (event.code === 'KeyF' && !event.ctrlKey && !event.altKey && !event.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    event.preventDefault(); void toggleFullscreen();
  }
});
$('start-internet').addEventListener('click', async () => {
  if (!desktop || busy) return;
  if (!meeting?.selfId) $('server-url').value = nativeInfo.localOrigin;
  try { await desktop.startInternet(); toast('Internet address ready. Copy the NEW meeting code for your friends.'); }
  catch (error) { message(error.message, true); }
});
$('stop-internet').addEventListener('click', () => desktop?.stopInternet().catch(error => message(error.message, true)));
$('server-url').addEventListener('input', updateNetwork);
$('feedback-mode').value = saved.get('feedback', 'voice');
$('feedback-mode').addEventListener('change', () => { saved.set('feedback', $('feedback-mode').value); feedback.prime(); });
$('enable-audio').addEventListener('click', async () => {
  $('enable-audio').hidden = true;
  for (const media of document.querySelectorAll('video, audio')) if (media.srcObject) attemptPlayback(media);
});
$('cancel-source').addEventListener('click', () => $('source-dialog').close());
$('chat-form').addEventListener('submit', event => {
  event.preventDefault(); const text = $('chat-input').value.trim();
  if (text && meeting?.selfId) { meeting.sendChat(text); $('chat-input').value = ''; }
});
for (const id of ['fps', 'resolution', 'bitrate', 'codec']) {
  $(id).value = saved.get(id, $(id).value);
  $(id).addEventListener('change', async () => {
    saved.set(id, $(id).value); resetMetrics();
    try {
      const applied = await meeting?.updateSettings(settings());
      updateQuality(applied);
      $('settings-note').textContent = 'Quality target requested. Capture and live stream values below show what the source and connection actually deliver.';
      if (meeting?.screenStream) message(`Sharing${meeting.screenStream.getAudioTracks().length ? ' with system audio' : ''}. ${$('fps').value} FPS requested; ${$('resolution').value === '0' ? 'original/source resolution' : `up to ${$('resolution').value}p target`}. See actual quality below.`);
    }
    catch (error) { message(error.message, true); }
  });
}
window.addEventListener('beforeunload', () => meeting?.close());

function readInvitation() {
  const code = new URLSearchParams(location.hash.slice(1)).get('code');
  if (!code) return;
  const autoOpen = new URLSearchParams(location.search).get('open') === 'app';
  history.replaceState(null, '', location.pathname);
  applyInvitation({ server: location.origin, code }, autoOpen);
}
window.addEventListener('hashchange', readInvitation);

async function initialize() {
  try {
    configuration = await fetch('/api/config').then(response => response.json());
    if (desktop) nativeInfo = await desktop.getInfo();
    if (nativeInfo?.internet) internetState = nativeInfo.internet;
  } catch (error) { message(`Could not read local configuration: ${error.message}`, true); }
  $('display-name').value = saved.get('name');
  $('server-url').value = configuration.publicUrl || saved.get('server') || location.origin;
  desktop?.onInternetState(state => { internetState = state; refreshControls(); if (state.error) message(state.error, true); });
  $('platform-label').textContent = desktop ? 'WINDOWS DESKTOP' : 'BROWSER EDITION';
  if (nativeInfo?.version) document.title = `Together ${nativeInfo.version} — Watch together`;
  initialized = true;
  readInvitation();
  if (queuedInvitation || nativeInfo?.invitation) { const invitation = queuedInvitation || nativeInfo.invitation; queuedInvitation = null; applyInvitation(invitation); }
  if (!window.isSecureContext) message('This LAN page can watch streams. Use the desktop app or HTTPS to turn on your camera and microphone.');
  refreshControls(); renderStage(); resetMetrics(); updateQuality();
}
initialize();

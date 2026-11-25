import { MeetingEngine, probeParty } from './engine.js';
import { DeviceFeedback } from './feedback.js';
import { NetworkSetup, safeNetworkInvite } from './network-setup.js';

const $ = id => document.getElementById(id);
let meeting = null, busy = false, captureBusy = false, nativeInfo = null, configuration = {};
let currentMembers = [], stageOwner = null, toastTimer;
let sourceDetails = null, lastStats = null, internetState = { state: 'off', url: null };
let activeInvitation = null, queuedInvitation = null, initialized = false;
let networkState = { state: 'unavailable', installed: false, ip: null, peers: [], message: '' }, networkBusy = false;
let savedParties = [], partyStatuses = new Map(), partyRefreshBusy = false, partySaveBusy = false;
let connectionSetup = null;
const participantStreams = new Map();
const deviceBusy = new Set();
const desktop = window.togetherDesktop;
desktop?.onInvitation?.(invitation => { if (initialized) applyInvitation(invitation); else queuedInvitation = invitation; });
const feedback = new DeviceFeedback(() => $('feedback-mode').value);
document.querySelector('label[for="fps"]').textContent = 'FRAME RATE TARGET';
$('internet-note').textContent = 'Your PC hosts the room. The free public tunnel uses no account or paid fallback. If the provider refuses free access, internet sharing stops with an explanation. Your internet data allowance applies.';
$('resolution').prepend(new Option('Original / source resolution', '0', true, true));
$('bitrate').prepend(new Option('Automatic · match stream priority', '0', true, true));
const saved = {
  get(key, fallback = '') { try { return localStorage.getItem(`together.${key}`) || fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`together.${key}`, value); } catch {} },
};
const reconnectButton = document.createElement('button');
reconnectButton.id = 'reconnect-media'; reconnectButton.type = 'button'; reconnectButton.className = 'control-button';
reconnectButton.textContent = 'Reconnect media'; reconnectButton.disabled = true;
document.querySelector('.call-controls').append(reconnectButton);

function settings() {
  return { fps: +$('fps').value, resolution: +$('resolution').value, bitrate: +$('bitrate').value, codec: $('codec').value, mode: $('stream-mode').value };
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
    const network = link.searchParams.get('network');
    if (network && !safeNetworkInvite(network)) throw new Error('The network invitation is not an official Tailscale invitation.');
    return { code, server: safeServer(link.searchParams.get('server')), ...(network ? { network } : {}) };
  }
  if (shortCode.test(value)) return { code: value, server: safeServer($('server-url').value.trim()) };
  let text = value;
  if (!/^https?:\/\//i.test(text)) {
    const host = text.split('/')[0];
    text = (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) ? 'http://' : 'https://') + text;
  }
  try {
    const url = new URL(text);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const code = fragment.get('code') || decodeURIComponent(url.pathname.slice(1));
    if (!shortCode.test(code)) throw new Error();
    const network = fragment.get('network');
    if (network && !safeNetworkInvite(network)) throw new Error();
    return { code, server: safeServer(url.origin), ...(network ? { network } : {}) };
  } catch { throw new Error('That code is incomplete. Paste the full code or invite link from your host.'); }
}
function invitationOrigin() {
  const selected = safeServer($('server-url').value.trim());
  if (nativeInfo && selected === nativeInfo.localOrigin && networkState.state === 'connected' && networkState.ip) {
    const port = new URL(nativeInfo.localOrigin).port;
    return `http://${networkState.ip}${port ? `:${port}` : ''}`;
  }
  if (nativeInfo && selected === nativeInfo.localOrigin) return internetState.url || configuration.publicUrl || nativeInfo.lanOrigin;
  return selected;
}
function portableCode() {
  const address = invitationOrigin();
  return `${address}/#code=${encodeURIComponent(meeting.code)}`;
}
function inviteLink() { return `${invitationOrigin()}/?open=app#code=${encodeURIComponent(meeting.code)}`; }
function appLink(invitation = { server: invitationOrigin(), code: meeting.code }) {
  const link = new URL('together-watch://join');
  link.searchParams.set('server', invitation.server); link.searchParams.set('code', invitation.code);
  if (invitation.network && safeNetworkInvite(invitation.network)) link.searchParams.set('network', invitation.network);
  return link.href;
}
function canonicalInvite(invitation) { return `${invitation.server}/#code=${encodeURIComponent(invitation.code)}`; }
function normalizePartyList(records) {
  if (!Array.isArray(records)) return [];
  return records.slice(0, 50).flatMap(record => {
    try {
      const parsed = parseCode(record.invite);
      return [{ id: String(record.id || canonicalInvite(parsed)), title: String(record.title || `Party ${parsed.code.slice(0, 8)}`).trim().slice(0, 64), invite: canonicalInvite(parsed) }];
    } catch { return []; }
  });
}
let partyStorageQueue = Promise.resolve();
function partyStorageTask(action) {
  const task = partyStorageQueue.then(action);
  partyStorageQueue = task.catch(() => {});
  return task;
}
async function loadSavedParties() {
  savedParties = normalizePartyList(desktop?.getParties ? await desktop.getParties() : JSON.parse(saved.get('parties', '[]')));
  renderSavedParties();
}
function saveParty(invite, title) {
  return partyStorageTask(async () => {
    const parsed = parseCode(invite), canonical = canonicalInvite(parsed);
    const previous = savedParties.find(party => { try { return parseCode(party.invite).code === parsed.code; } catch { return false; } });
    const record = { title: String(title || previous?.title || `Party ${parsed.code.slice(0, 8)}`).slice(0, 64), invite: canonical };
    if (desktop?.saveParty) {
      savedParties = normalizePartyList(await desktop.saveParty(record));
      const replacement = savedParties.find(party => party.invite === canonical);
      if (previous && replacement && previous.id !== replacement.id && desktop.removeParty) savedParties = normalizePartyList(await desktop.removeParty(previous.id));
    } else {
      savedParties = savedParties.filter(party => party.id !== previous?.id);
      savedParties.unshift({ ...record, id: previous?.id || crypto.randomUUID() });
      savedParties = savedParties.slice(0, 50); localStorage.setItem('together.parties', JSON.stringify(savedParties));
    }
    renderSavedParties();
  });
}
async function removeSavedParty(id) {
  try {
    await partyStorageTask(async () => {
      if (desktop?.removeParty) savedParties = normalizePartyList(await desktop.removeParty(id));
      else { savedParties = savedParties.filter(party => party.id !== id); localStorage.setItem('together.parties', JSON.stringify(savedParties)); }
      partyStatuses.delete(id); renderSavedParties();
    });
    toast('Removed from this device. Your friends can still use their invite.');
  } catch (error) { message(`Could not remove saved party: ${error.message}`, true); }
}
function renderSavedParties() {
  const container = $('saved-parties'); container.replaceChildren();
  $('party-count').textContent = String(savedParties.length);
  $('refresh-parties').disabled = partyRefreshBusy || !savedParties.length;
  $('refresh-parties').textContent = partyRefreshBusy ? 'Checking people…' : 'Refresh people';
  if (!savedParties.length) {
    const empty = document.createElement('p'); empty.className = 'parties-empty'; empty.textContent = 'Create a named party, or save a friend’s invite. Your usual rooms will be waiting here.'; container.append(empty); return;
  }
  for (const party of savedParties) {
    let parsed; try { parsed = parseCode(party.invite); } catch { continue; }
    const inThisParty = !!meeting?.selfId && meeting.code === parsed.code;
    const status = inThisParty ? { exists: true, title: meeting.title, members: currentMembers, persistent: meeting.persistent } : partyStatuses.get(party.id);
    const members = status?.members || [];
    const card = document.createElement('article'); card.className = 'party-card'; card.dataset.partyId = party.id;
    card.classList.toggle('is-present', members.length > 0);
    const heading = document.createElement('div'); heading.className = 'party-card-heading';
    const title = document.createElement('h3'); title.textContent = status?.title || party.title;
    const badge = document.createElement('span'); badge.className = 'party-card-badge'; badge.textContent = inThisParty ? 'YOU’RE HERE' : status?.exists ? members.length ? `${members.length} HERE` : 'READY' : 'SAVED';
    heading.append(title, badge);
    const presence = document.createElement('p'); presence.className = 'party-presence';
    presence.textContent = status?.checking && !status?.exists ? 'Checking the party’s host…' : status?.exists
      ? members.length ? members.map(member => member.name).join(', ') : 'No one here yet. Take the first seat.'
      : status?.missing ? 'Room not found. Ask your friend for a current invite.' : status?.unreachable ? 'Host offline or unreachable. Keep the creator’s app running.' : 'Refresh to see who’s here.';
    const address = document.createElement('p'); address.className = 'party-address'; address.textContent = new URL(parsed.server).host;
    if (status?.exists && status.persistent === false) address.textContent += ' · one-time room; expires when the host leaves';
    const actions = document.createElement('div'); actions.className = 'party-actions';
    const join = document.createElement('button'); join.type = 'button'; join.className = 'button button-light party-join'; join.textContent = inThisParty ? 'In this party' : meeting?.selfId ? 'Leave room to join' : 'Join party'; join.disabled = busy || !!meeting?.selfId;
    join.addEventListener('click', async () => { applyInvitation(parsed); await enterRoom(false); });
    const copyButton = document.createElement('button'); copyButton.type = 'button'; copyButton.className = 'text-button party-copy'; copyButton.textContent = 'Copy invite'; copyButton.addEventListener('click', () => copy(party.invite).catch(error => message(error.message, true)));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button party-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${party.title} from this device`); remove.addEventListener('click', () => removeSavedParty(party.id));
    actions.append(join, copyButton, remove); card.append(heading, presence, address, actions); container.append(card);
  }
}
async function refreshParties() {
  if (partyRefreshBusy || !savedParties.length) return;
  partyRefreshBusy = true;
  const pending = [...savedParties];
  for (const party of pending) partyStatuses.set(party.id, { ...partyStatuses.get(party.id), checking: true });
  renderSavedParties();
  try {
    for (let offset = 0; offset < pending.length; offset += 4) await Promise.allSettled(pending.slice(offset, offset + 4).map(async party => {
      try {
        const { server, code } = parseCode(party.invite);
        const status = await probeParty(server, code, { timeout: 4000 });
        partyStatuses.set(party.id, status.exists ? status : { missing: true });
      } catch { partyStatuses.set(party.id, { unreachable: true }); }
      renderSavedParties();
    }));
  } finally { partyRefreshBusy = false; renderSavedParties(); }
}
async function saveCurrentParty(source, data) {
  if (!data.persistent || source !== meeting) return;
  try {
    await saveParty(portableCode(), data.title);
    if (source === meeting) renderSavedParties();
  } catch (error) { message(`Room connected, but this device could not save the party: ${error.message}`, true); }
}
async function saveInvitation() {
  if (partySaveBusy) return;
  partySaveBusy = true; $('save-party-invite').disabled = true;
  try {
    const parsed = activeInvitation && !activeInvitation.invalid ? activeInvitation : parseCode($('meeting-code').value);
    let status; try { status = await probeParty(parsed.server, parsed.code, { timeout: 4000 }); } catch {}
    if (status && !status.exists) throw new Error('That room was not found. Ask your friend for its latest invite.');
    await saveParty(canonicalInvite(parsed), status?.title);
    if (status?.exists) { const party = savedParties.find(item => item.invite === canonicalInvite(parsed)); if (party) partyStatuses.set(party.id, status); }
    renderSavedParties(); toast(status?.persistent === false ? 'Invite saved. This one-time room lasts while its host stays.' : status ? 'Party saved. Come back with one click.' : 'Invite saved. Its host could not be reached yet.');
  } catch (error) { message(`Could not save invite: ${error.message}`, true); }
  finally { partySaveBusy = false; refreshControls(); }
}
function applyInvitation(invitation, autoOpen = false) {
  if (!invitation?.code) return;
  const server = safeServer(invitation.server);
  if (meeting?.selfId || busy) {
    if (meeting?.code === invitation.code) toast('You are already in this room.');
    else { queuedInvitation = { server, code: invitation.code }; message('Leave your current room to join the new invitation.'); }
    return;
  }
  activeInvitation = { server, code: invitation.code, invalid: !/^[A-Z2-7]{8}-[A-Za-z0-9_-]{12}$/i.test(invitation.code), ...(safeNetworkInvite(invitation.network) ? { network: invitation.network } : {}) };
  $('server-url').value = server;
  $('meeting-code').value = `${server}/#code=${encodeURIComponent(invitation.code)}`;
  refreshControls();
  message(activeInvitation.invalid ? 'This invitation has an invalid meeting code.' : `Invitation to ${invitation.code.slice(0, 8)}. Add your name and choose Join this room.` , activeInvitation.invalid);
  if (autoOpen && !desktop && !activeInvitation.invalid) setTimeout(openInvitationInApp, 200);
  if (desktop && activeInvitation.network && !activeInvitation.invalid) connectionSetup?.open(activeInvitation);
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
    'not-sharing': 'No one is sharing a screen. Anyone in the room can start.',
    'waiting-peer': 'Waiting for a viewer. Local preview is not a transmitted video stream.',
    'media-unavailable': `The room is connected, but video/audio is not connected.${data.recovering ? ' Automatic media recovery is running.' : ' Connect both PCs to the same private network or configure TURN, then choose Reconnect media.'}`,
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
    if (peer.retries) lines.push(`Media recovery attempts: ${peer.retries}/4`);
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
  $('private-network-panel').hidden = !desktop;
  const networkLabels = { connected: 'Private network connected', stopped: 'Private network is stopped', 'login-required': 'Sign in to connect your network', 'approval-required': 'Device approval is needed', missing: 'Private network setup needed', unavailable: 'Private network could not be checked' };
  $('network-state').textContent = networkBusy ? 'Checking private connection…' : networkLabels[networkState.state] || 'Private network setup';
  $('network-indicator').classList.toggle('connected', networkState.state === 'connected');
  $('network-message').textContent = networkState.message || 'Install Tailscale on both PCs and connect them to the same private network. Together never needs your network password.';
  $('connect-network').disabled = networkBusy || networkState.state === 'connected';
  $('connect-network').textContent = networkBusy ? 'Connecting…' : networkState.state === 'connected' ? 'Connected' : networkState.state === 'missing' ? 'Get private network app' : networkState.state === 'login-required' ? 'Sign in to connect' : networkState.state === 'approval-required' ? 'Check device approval' : 'Connect private network';
  $('refresh-network').disabled = networkBusy;
  const peers = Array.isArray(networkState.peers) ? networkState.peers : [];
  $('network-peers').replaceChildren(); $('network-peers').hidden = !peers.length;
  if (peers.length) {
    const label = document.createElement('span'); label.className = 'field-label'; label.textContent = 'DEVICES ON YOUR NETWORK'; $('network-peers').append(label);
    for (const peer of peers.slice(0, 8)) {
      const row = document.createElement('div'); row.className = 'network-peer';
      const name = document.createElement('span'); name.textContent = peer.name || 'Network device';
      const state = document.createElement('span'); state.textContent = peer.online ? 'Online' : 'Offline'; state.className = peer.online ? 'online' : '';
      row.append(name, state); $('network-peers').append(row);
    }
  }
  $('start-internet').hidden = !desktop || online;
  $('start-internet').disabled = working || busy || !!activeInvitation || (active && (!local || meeting.role !== 'host'));
  $('start-internet').textContent = working ? 'Creating public address…' : 'Start internet room · free';
  $('stop-internet').hidden = !desktop || (!online && !working);
  $('stop-internet').textContent = working ? 'Cancel internet setup' : 'Stop public address';
  $('internet-note').hidden = !desktop;
  $('public-address-options').hidden = !desktop;
  let address = $('server-url').value;
  try { address = invitationOrigin(); } catch {}
  const privateAddress = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(address);
  const tailnet = /^http:\/\/100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
  $('reachability-badge').textContent = tailnet ? 'Private network address' : working ? 'Preparing internet access' : privateAddress ? 'Local network only' : 'Internet server address';
  $('reachability-note').textContent = working
    ? 'Your existing local room stays connected while a public address is created.'
    : privateAddress
      ? 'This invite works on the same LAN. Connect the private network on both PCs for friends elsewhere; Together will choose that address automatically.'
      : `Friends elsewhere can join with the full code. Keep this PC and Together running.${online ? ' Stopping the public address disconnects internet guests.' : ''}`;
  if (tailnet) $('reachability-note').textContent = 'Use this full meeting code in the Together desktop app. Both PCs must be connected to the same private network. The public internet link is not required.';
  else if (internetState.error) $('reachability-note').textContent = internetState.error;
}
async function checkNetwork(connect = false) {
  if (!desktop || networkBusy) return;
  const previousState = networkState.state, previousIp = networkState.ip;
  networkBusy = true; updateNetwork();
  try {
    if (connect && desktop.connectNetwork) networkState = await desktop.connectNetwork();
    else if (desktop.getNetworkStatus) networkState = await desktop.getNetworkStatus();
    else networkState = nativeInfo?.privateOrigin
      ? { state: 'connected', installed: true, ip: new URL(nativeInfo.privateOrigin).hostname, peers: [], message: 'Private adapter found. Your friend must connect to the same private network.' }
      : { state: 'unavailable', installed: false, ip: null, peers: [], message: 'Run the latest Together app to check and connect your private network here.' };
    nativeInfo = await desktop.getInfo();
    if (networkState.authUrlOpened) message('Your network sign-in page is open. Finish signing in, then choose Check again.');
    if (networkState.state === 'connected' && meeting?.selfId && (previousState !== 'connected' || previousIp !== networkState.ip)) {
      $('room-code').textContent = portableCode(); meeting.retryMedia();
      if (meeting.persistent) await saveCurrentParty(meeting, { persistent: true, title: meeting.title });
    }
  } catch (error) { networkState = { state: 'unavailable', installed: false, ip: null, peers: [], message: error.message }; }
  finally { networkBusy = false; updateNetwork(); connectionSetup?.render(); }
}
function updateQuality(capture) {
  if (meeting?.presenterId && meeting.presenterId !== meeting.selfId) {
    $('quality-summary').textContent = lastStats?.resolution
      ? `Receiving: ${lastStats.resolution}${lastStats.fps == null ? '' : ` · ${Math.round(lastStats.fps)} FPS`}\nThe person sharing controls stream quality.`
      : 'Waiting for the shared screen. The person sharing controls stream quality.';
    $('quality-summary').classList.remove('limited');
    return;
  }
  const track = meeting?.screenStream?.getVideoTracks()[0];
  const actual = capture || track?.getSettings();
  const target = settings();
  const modes = { smooth: 'Smooth motion prioritizes steady frame delivery; detail may scale down for slower viewers.', balanced: 'Balanced mode adapts motion and detail to each viewer’s connection.', source: 'Source detail preserves your quality targets; demanding sources may reduce frame delivery.' };
  $('stream-mode-note').textContent = modes[target.mode];
  const parts = [target.resolution === 0 ? `Original/source resolution · ${target.fps} FPS target` : `Target: up to ${Math.round(target.resolution * 16 / 9)} × ${target.resolution} · ${target.fps} FPS`];
  parts.push(modes[target.mode]);
  parts.push(target.bitrate === 0
    ? target.mode === 'source' ? 'Bandwidth: runtime congestion control, with no app bitrate cap' : 'Bandwidth: automatic per-viewer cap that adapts with motion and detail'
    : `Bandwidth limit: ${target.bitrate} Mbps per viewer`);
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
  $('party-create').hidden = !!activeInvitation;
  $('create-party').disabled = busy || !!activeInvitation;
  $('party-name').disabled = busy;
  $('save-party-invite').disabled = partySaveBusy || busy || !$('meeting-code').value.trim() || !!activeInvitation?.invalid;
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
  $('reconnect-media').disabled = !active;
  const otherSharing = active && meeting.presenterId && meeting.presenterId !== meeting.selfId;
  $('share-screen').disabled = !active || !!otherSharing || captureBusy;
  $('share-screen').title = otherSharing ? 'Someone is sharing. Ask them to stop before sharing your screen.' : '';
  $('share-screen').textContent = meeting?.screenStream ? 'Stop sharing' : 'Share screen';
  $('toggle-mic').textContent = meeting?.microphoneStream ? 'Mute microphone' : 'Turn on microphone';
  $('toggle-camera').textContent = meeting?.cameraStream ? 'Turn off camera' : 'Turn on camera';
  $('toggle-mic').setAttribute('aria-pressed', String(!!meeting?.microphoneStream));
  $('toggle-camera').setAttribute('aria-pressed', String(!!meeting?.cameraStream));
  $('share-screen').setAttribute('aria-pressed', String(!!meeting?.screenStream));
  $('system-audio').disabled = captureBusy || !!meeting?.screenStream || !!otherSharing;
  for (const id of ['fps', 'resolution', 'bitrate', 'codec', 'stream-mode']) $(id).disabled = !!otherSharing;
  document.querySelector('.settings-grid').hidden = !!otherSharing;
  $('chat-input').disabled = !active;
  $('chat-form').querySelector('button').disabled = !active;
  $('connection-status').textContent = active ? 'Room connected' : busy ? 'Connecting…' : 'Ready when you are';
  $('connection-status').classList.toggle('connected', active);
  if (active) {
    $('room-code').textContent = portableCode();
    $('room-title').textContent = meeting.persistent ? meeting.title || 'Your friend party' : `${meeting.code.split('-')[0]} · ${meeting.role === 'host' ? 'Your room' : 'Watching together'}`;
  } else {
    $('room-title').textContent = 'Your next watch party';
  }
  $('member-count').textContent = `${currentMembers.length} / ${configuration.maxMembers || 6}`;
  updateNetwork();
  renderSavedParties();
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
  $('stage-caption').textContent = live ? `${sharing.name}${sharing.id === meeting?.selfId ? ' (you)' : ''} is sharing` : meeting?.selfId ? 'Anyone can share when the screen is free' : 'A little closer, wherever you are';
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
      message('Room connected. Anyone can share a screen, microphone, or camera. One screen at a time.');
      $('settings-note').textContent = 'The person sharing chooses stream quality. Live counters show actual delivered performance.';
      void saveCurrentParty(source, data);
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
      {
        const adjusted = (data.peerStats || []).filter(peer => peer.adaptation?.level > 0);
        if (adjusted.length && data.kind === 'sending') $('settings-note').textContent = `${settings().mode === 'smooth' ? 'Smooth motion' : 'Balanced'} mode adjusted detail for ${adjusted.length} viewer${adjusted.length === 1 ? '' : 's'} to help frames arrive steadily. Live FPS remains measured.`;
      }
      showVideoHealth(data);
      updateQuality();
      break;
    case 'ended':
      currentMembers = []; participantStreams.clear(); busy = false; stageOwner = null; lastStats = null; sourceDetails = null;
      $('screen-video').srcObject = null; $('enable-audio').hidden = true;
      meeting = null; refreshControls(); renderStage(); updateQuality(); message(data.message || 'You left the room.');
      if (queuedInvitation) { const invitation = queuedInvitation; queuedInvitation = null; applyInvitation(invitation); }
      void refreshParties();
      break;
    case 'adaptation':
      if (data.level > 0) $('settings-note').textContent = `${data.mode === 'smooth' ? 'Smooth motion' : 'Balanced'} mode is adjusting detail for ${data.name || 'a viewer'} to keep the stream moving. Actual FPS is shown above.`;
      break;
  }
}
async function enterRoom(create, persistent = false, fromSetup = false) {
  if (busy || meeting?.selfId) return;
  if (create && activeInvitation) { message('This is an invitation. Choose Join this room to meet your host.'); return; }
  busy = true; refreshControls();
  let instance;
  try {
    const name = $('display-name').value.trim();
    if (!name) throw new Error('Add your name first.');
    const partyName = $('party-name').value.trim();
    if (persistent && !partyName) { $('party-name').focus(); throw new Error('Give your saved party a name first.'); }
    const parsed = create ? { server: persistent && nativeInfo ? nativeInfo.localOrigin : safeServer($('server-url').value.trim()) } : activeInvitation && !activeInvitation.invalid ? activeInvitation : parseCode($('meeting-code').value);
    if (!create && desktop && !fromSetup && parsed.network) { applyInvitation(parsed); connectionSetup.open(parsed); return; }
    $('server-url').value = parsed.server;
    saved.set('name', name);
    if (!nativeInfo || parsed.server !== nativeInfo.localOrigin) saved.set('server', parsed.server);
    instance = new MeetingEngine({ serverUrl: parsed.server, name, settings: settings(), onEvent: (type, data) => handleEvent(instance, type, data) });
    meeting = instance;
    $('messages').replaceChildren();
    await (persistent ? instance.createParty(partyName) : create ? instance.create() : instance.join(parsed.code));
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
  if (!meeting?.selfId || captureBusy) return;
  if (meeting.presenterId && meeting.presenterId !== meeting.selfId) { message('Someone is already sharing. Ask them to stop before sharing your screen.'); return; }
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
$('create-party').addEventListener('click', () => enterRoom(true, true));
$('party-name').addEventListener('keydown', event => { if (event.key === 'Enter') enterRoom(true, true); });
$('save-party-invite').addEventListener('click', saveInvitation);
$('refresh-parties').addEventListener('click', refreshParties);
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
for (const id of ['fps', 'resolution', 'bitrate', 'codec', 'stream-mode']) {
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
$('reconnect-media').addEventListener('click', () => {
  try { const count = meeting?.retryMedia() || 0; message(count ? 'Retrying media connections. Your screen, microphone, and camera choices are kept.' : 'All current participant media connections are already connected.'); }
  catch (error) { message(error.message, true); }
});
$('connect-network').addEventListener('click', () => networkState.installed ? checkNetwork(true) : connectionSetup.open());
$('refresh-network').addEventListener('click', () => checkNetwork(false));
$('network-help').addEventListener('click', () => connectionSetup.open());
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshParties(); });
const partyPoll = setInterval(() => { if (!document.hidden) void refreshParties(); }, 15000);
const networkPoll = setInterval(() => { if (desktop && !document.hidden) void checkNetwork(); }, 15000);
window.addEventListener('focus', () => { if (desktop && initialized) void checkNetwork(); });
window.addEventListener('beforeunload', () => { clearInterval(partyPoll); clearInterval(networkPoll); });

function readInvitation() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = fragment.get('code');
  if (!code) return;
  const autoOpen = new URLSearchParams(location.search).get('open') === 'app';
  history.replaceState(null, '', location.pathname);
  applyInvitation({ server: location.origin, code, network: fragment.get('network') }, autoOpen);
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
  try { await loadSavedParties(); } catch (error) { message(`Could not read your saved parties: ${error.message}`, true); }
  desktop?.onInternetState(state => { internetState = state; refreshControls(); if (state.error) message(state.error, true); });
  $('platform-label').textContent = desktop ? 'WINDOWS DESKTOP' : 'BROWSER EDITION';
  if (nativeInfo?.version) document.title = `Together ${nativeInfo.version} — Watch together`;
  initialized = true;
  readInvitation();
  if (queuedInvitation || nativeInfo?.invitation) { const invitation = queuedInvitation || nativeInfo.invitation; queuedInvitation = null; applyInvitation(invitation); }
  if (!window.isSecureContext) message('This LAN page can watch streams. Use the desktop app or HTTPS to turn on your camera and microphone.');
  refreshControls(); renderStage(); resetMetrics(); updateQuality();
  void checkNetwork(); void refreshParties();
  if (nativeInfo?.serverPortChanged) message('The previous room port was busy, so Together used another port. Copy fresh invites for parties hosted on this PC.', true);
}
connectionSetup = new NetworkSetup({ desktop, getState: () => networkState, refresh: checkNetwork, isInRoom: () => !!meeting?.selfId,
  getParty: () => {
    if (meeting?.selfId) return { server: invitationOrigin(), code: meeting.code };
    if (activeInvitation && !activeInvitation.invalid) return activeInvitation;
    try { return parseCode($('meeting-code').value); } catch { return null; }
  }, join: async party => {
    if (meeting?.selfId) return;
    // Close setup first; the actual Join button remains an explicit user action.
    applyInvitation({ server: party.server, code: party.code });
    await enterRoom(false, false, true);
  }, copy, message });
initialize();

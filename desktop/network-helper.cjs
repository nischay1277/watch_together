const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function tailnetIPv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127
    && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255);
}
function findTailscale({ exists = fs.existsSync, env = process.env } = {}) {
  const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [...roots.map(root => path.join(root, 'Tailscale', 'tailscale.exe')), 'D:\\Tailscale\\tailscale.exe'];
  return candidates.find(candidate => exists(candidate)) || null;
}
function runCli(executable, args, timeout = 7000) {
  return new Promise((resolve, reject) => execFile(executable, args,
    { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false },
    (error, stdout, stderr) => {
      // The CLI returns exit 1 with valid JSON while logged out or disconnected.
      const partialLogin = ['login', 'up'].includes(args[0]) && `${stdout}\n${stderr}`.match(/https:\/\/login\.tailscale\.com\/[A-Za-z0-9_/?=&.-]+/);
      if (partialLogin && safeAuthUrl(partialLogin[0])) resolve(`${stdout}\n${stderr}`);
      else if (!error || (args[0] === 'status' && error.code === 1 && stdout.trim().startsWith('{'))) resolve(stdout);
      else reject(error);
    }));
}
function safeAuthUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'login.tailscale.com' && !url.port
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function safeNetworkInvite(raw) {
  try {
    const url = new URL(raw);
    return raw.length <= 2048 && url.protocol === 'https:' && ['login.tailscale.com', 'console.tailscale.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/(?:uinv|invite|admin\/invite)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
function summarizeStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid network status.');
  const ip = (raw.TailscaleIPs || []).find(tailnetIPv4) || null;
  const peers = Object.values(raw.Peer || {}).slice(0, 100).map(peer => ({
    name: String(peer.HostName || 'Friend’s PC').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80),
    ip: (peer.TailscaleIPs || []).find(tailnetIPv4) || null,
    online: peer.Online === true,
  })).filter(peer => peer.ip);
  let state = 'unavailable', message = 'The private network is starting. Try checking again shortly.';
  if (raw.BackendState === 'Running' && ip) {
    state = 'connected';
    message = peers.some(peer => peer.online)
      ? 'Private network connected. Your online friends can join a saved party.'
      : 'Private network connected. Invite your friend once so their PC appears here.';
  } else if (['NeedsLogin', 'NoState'].includes(raw.BackendState)) {
    state = 'login-required'; message = 'Sign in once to connect this PC. Your friend must join the same private network.';
  } else if (raw.BackendState === 'Stopped') {
    state = 'stopped'; message = 'Private network is disconnected. Connect here to bring it online.';
  } else if (raw.BackendState === 'NeedsMachineAuth') {
    state = 'approval-required'; message = 'Approve this PC in your Tailscale admin console, then check again.';
  }
  return { state, installed: true, ip, peers, message };
}
function createNetworkHelper({ find = findTailscale, run = runCli, openExternal = async () => {} } = {}) {
  let connecting = null;
  async function readRaw() {
    const executable = find();
    if (!executable) return { status: { state: 'missing', installed: false, ip: null, peers: [], message: 'Install Tailscale once on each PC, then connect here. Personal use has a free plan.' } };
    try {
      const raw = JSON.parse(await run(executable, ['status', '--json']));
      return { executable, raw, status: summarizeStatus(raw) };
    } catch {
      return { executable, status: { state: 'unavailable', installed: true, ip: null, peers: [], message: 'Tailscale is installed but its background service is not responding. Start Tailscale once, then check again.' } };
    }
  }
  async function status() { return (await readRaw()).status; }
  async function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      let info = await readRaw();
      if (!info.executable || info.status.state === 'connected') return info.status;
      // Run only on an explicit Connect action. Existing service settings are preserved.
      try { await run(info.executable, ['up', '--timeout=5s'], 7000); } catch { /* Read safe status instead of echoing CLI output. */ }
      info = await readRaw();
      const authUrl = safeAuthUrl(info.raw?.AuthURL);
      if (authUrl) {
        await openExternal(authUrl);
        return { ...info.status, authUrlOpened: true, message: 'Finish the one-time sign-in in your browser, then click Check connection here.' };
      }
      return info.status;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function help() {
    await openExternal(find() ? 'https://login.tailscale.com/admin/users' : 'https://tailscale.com/download/windows');
    return { opened: true };
  }
  async function acceptInvite(raw) {
    const url = safeNetworkInvite(raw);
    if (!url) throw new Error('Use the original Tailscale network invitation, starting with https://login.tailscale.com/uinv/.');
    await openExternal(url);
    return { opened: true };
  }
  async function profiles() {
    const executable = find();
    if (!executable) return [];
    try {
      const rows = JSON.parse(await run(executable, ['switch', '--list', '--json']));
      if (!Array.isArray(rows)) return [];
      return rows.slice(0, 30).filter(item => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item?.id || '')).map(item => ({
        id: item.id, label: String(item.tailnet || item.nickname || 'Saved network').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100), selected: item.selected === true,
      }));
    } catch { return []; }
  }
  async function switchProfile(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('Choose a saved network from the list.');
    const allowed = await profiles();
    if (!allowed.some(profile => profile.id === id)) throw new Error('That network is not signed in on this PC. Add it first.');
    const executable = find();
    try { await run(executable, ['switch', id], 10000); }
    catch { throw new Error('The network could not be switched. Check the connection and try again.'); }
    return status();
  }
  async function addProfile() {
    const executable = find();
    if (!executable) return status();
    let output = '';
    try { output = await run(executable, ['login', '--timeout=5s'], 7000); } catch {}
    const match = output.match(/https:\/\/login\.tailscale\.com\/[A-Za-z0-9_/?=&.-]+/);
    const info = await readRaw();
    const url = safeAuthUrl(match?.[0]) || safeAuthUrl(info.raw?.AuthURL);
    if (url) { await openExternal(url); return { ...info.status, authUrlOpened: true }; }
    return { ...info.status, message: 'Network sign-in was requested. If no browser page opened, check your Tailscale installation and try again.' };
  }
  return { status, connect, help, acceptInvite, profiles, switchProfile, addProfile };
}
module.exports = { tailnetIPv4, findTailscale, runCli, safeAuthUrl, safeNetworkInvite, summarizeStatus, createNetworkHelper };

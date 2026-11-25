const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const PACKAGE_ROOT = 'https://pkgs.tailscale.com/stable/';
function installerName(manifest, arch = process.arch) {
  const name = manifest?.MSIs?.[arch === 'arm64' ? 'arm64' : 'amd64'];
  if (typeof name !== 'string' || !/^tailscale-setup-\d+\.\d+\.\d+-(amd64|arm64)\.msi$/.test(name)) throw new Error('The official installer listing was not recognized.');
  return name;
}
async function fetchLimited(url, limit, fetcher = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error('The official connection-helper download is unavailable. No paid alternative was selected.');
  if (Number(response.headers.get('content-length')) > limit) throw new Error('The installer download was larger than expected.');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) throw new Error('The installer download was larger than expected.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function verifySignature(file) {
  const literal = file.replaceAll("'", "''");
  // A parent PowerShell 7 session can put incompatible modules ahead of the
  // Windows PowerShell modules. Load the verifier from this host's own PSHOME.
  const script = `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security') -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath '${literal}'; @{status=[string]$s.Status; subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 30000, maxBuffer: 8192, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('Windows could not verify the installer publisher. Installation was not started.'));
      try {
        const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
        if (value.status !== 'Valid' || !/(?:^|,\s*)(?:CN|O)=Tailscale Inc\.?(?:,|$)/i.test(value.subject || '')) throw new Error();
        resolve();
      } catch { reject(new Error('The installer does not have a valid Tailscale publisher signature. Installation was not started.')); }
    }));
}
function openInstaller(file, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/msiexec.exe'),
      ['/i', file, `INSTALLDIR=${target}`], { windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Windows Installer could not be opened.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
function createNetworkInstaller({ dataRoot, installed, download = fetchLimited, verify = verifySignature, open = openInstaller } = {}) {
  let inFlight = null, stage = null;
  function status() { return stage; }
  async function install() {
    if (installed()) return { state: 'installed', message: 'The connection helper is already installed. Continue with sign-in.' };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let partial;
      try {
        stage = { state: 'downloading', message: 'Downloading the official Tailscale installer…' };
        const manifest = JSON.parse((await download(`${PACKAGE_ROOT}?mode=json`, 512000)).toString('utf8'));
        const name = installerName(manifest);
        const directory = path.join(dataRoot, 'Network', 'Downloads');
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, name);
        partial = `${file}.${randomUUID()}.download.msi`;
        const bytes = await download(`${PACKAGE_ROOT}${name}`, 100 * 1024 * 1024);
        fs.writeFileSync(partial, bytes, { mode: 0o600 });
        stage = { state: 'verifying', message: 'Checking the installer’s Tailscale publisher signature…' };
        await verify(partial);
        fs.renameSync(partial, file);
        await open(file, path.join(dataRoot, 'Network', 'Tailscale'));
        stage = { state: 'installer-open', message: 'Finish the Windows installer and its administrator prompt. Together will detect it here. Windows may still store system components on C:.' };
        return stage;
      } catch (error) {
        stage = { state: 'failed', message: error.message || 'Connection-helper setup failed. No paid service was selected.' };
        return stage;
      } finally { if (partial && fs.existsSync(partial)) { try { fs.unlinkSync(partial); } catch {} } inFlight = null; }
    })();
    return inFlight;
  }
  return { install, status };
}
module.exports = { installerName, fetchLimited, verifySignature, createNetworkInstaller };

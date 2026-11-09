const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

function freeServiceError(status, detail = '') {
  const noPaidFallback = ' Internet access has been stopped. No paid service was started. Your local room can still be used.';
  if (status === 429 || /\b(?:quota exceeded|quota exhausted|rate limit(?:ed| exceeded)?|too many requests|(?:usage|bandwidth|request) limit (?:exceeded|reached))\b/i.test(detail)) {
    return 'The free public tunnel reached a provider limit (such as request rate or concurrent connections). Try free public access again later.' + noPaidFallback;
  }
  if (status === 402 || /\b(?:payment required|free trial expired|trial (?:ended|exhausted)|subscription expired)\b/i.test(detail)) {
    return 'The provider no longer offers free access for this connection or requested payment.' + noPaidFallback;
  }
  if (status === 403) return 'The provider refused public access (HTTP 403). This does not by itself identify a quota or expiry.' + noPaidFallback;
  return null;
}

class InternetTunnel {
  constructor({ binaryPath, origin, onState = () => {}, spawnProcess = spawn, fetchPublic = globalThis.fetch }) {
    const target = new URL(origin);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Internet rooms can expose only Together’s own local server.');
    this.binaryPath = binaryPath;
    this.origin = target.origin;
    this.onState = onState;
    this.state = { state: 'off', url: null, error: null };
    this.process = null;
    this.generation = 0;
    this.spawnProcess = spawnProcess;
    this.fetchPublic = fetchPublic;
    this.monitor = null;
  }

  update(state) { this.state = state; this.onState({ ...state }); }

  async start() {
    if (this.state.state === 'online') return this.state;
    if (this.pending) return this.pending;
    this.update({ state: 'starting', url: null, error: null });
    this.pending = this.launch(++this.generation).finally(() => { this.pending = null; });
    return this.pending;
  }

  async launch(generation) {
    try { await fs.access(this.binaryPath); }
    catch {
      const error = new Error('The Cloudflare helper is missing. Use the complete Together build or follow the manual internet setup guide.');
      this.update({ state: 'error', url: null, error: error.message });
      throw error;
    }
    if (generation !== this.generation) throw new Error('Internet setup was stopped.');
    return new Promise((resolve, reject) => {
      let output = '', url = null, registered = false, settled = false, checking = false;
      const child = this.spawnProcess(this.binaryPath, ['tunnel', '--url', this.origin, '--no-autoupdate', '--protocol', 'http2'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process = child;
      const timeout = setTimeout(() => fail('The public address could not connect within 60 seconds. Check your network, VPN, or firewall and try again.'), 60000);
      const fail = message => {
        if (this.process !== child) return;
        clearTimeout(timeout);
        clearInterval(this.monitor); this.monitor = null;
        this.process = null;
        child.kill();
        this.update({ state: 'error', url: null, error: message });
        if (!settled) { settled = true; reject(new Error(message)); }
      };
      const checkPublic = async () => {
        for (let attempt = 0; attempt < 25; attempt++) {
          if (this.process !== child || settled) return;
          try {
            const response = await this.fetchPublic(`${url}/health`, { signal: AbortSignal.timeout(5000) });
            const refusal = freeServiceError(response.status);
            if (refusal) { await response.body?.cancel(); fail(refusal); return; }
            const body = await response.json();
            if (response.ok && body.status === 'ok' && this.process === child && !settled) {
              settled = true; clearTimeout(timeout);
              this.update({ state: 'online', url, error: null });
              this.monitor = setInterval(async () => {
                if (this.process !== child) return;
                try {
                  const health = await this.fetchPublic(`${url}/health`, { signal: AbortSignal.timeout(5000) });
                  const refusal = freeServiceError(health.status);
                  await health.body?.cancel();
                  if (refusal) fail(refusal);
                } catch { /* Temporary network failures can recover through cloudflared. */ }
              }, 30000);
              this.monitor.unref?.();
              resolve(this.state); return;
            }
          } catch { /* New tunnel names can take a few seconds to propagate. */ }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        fail('Cloudflare connected, but its new public address is not reachable yet. Try starting the internet room again.');
      };
      const read = chunk => {
        if (this.process !== child) return;
        output = (output + chunk.toString()).slice(-12000);
        const status = output.match(/\b(?:HTTP\/[\d.]+\s+|status(?: code)?\s*[:=]?\s*|statusCode\s*[:=]?\s*)(402|403|429)\b/i)?.[1];
        const refusal = freeServiceError(Number(status || 0), output);
        if (refusal) { fail(refusal); return; }
        url ||= output.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        registered ||= output.includes('Registered tunnel connection');
        if (url && registered && !settled && !checking) { checking = true; void checkPublic(); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.on('error', () => fail('Could not start Cloudflare. Reinstall Together or check whether Windows blocked the helper.'));
      child.on('exit', () => {
        if (this.process !== child) {
          if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('Internet setup was stopped.')); }
          return;
        }
        fail('The public connection stopped. Check your internet connection and start the internet room again.');
      });
    });
  }

  stop() {
    ++this.generation;
    clearInterval(this.monitor); this.monitor = null;
    const child = this.process;
    this.process = null;
    child?.kill();
    this.update({ state: 'off', url: null, error: null });
    return this.state;
  }
}

module.exports = { InternetTunnel, freeServiceError };

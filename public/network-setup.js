export function safeNetworkInvite(raw) {
  try {
    const url = new URL(raw);
    return typeof raw === 'string' && raw.length <= 2048 && url.protocol === 'https:'
      && ['login.tailscale.com', 'console.tailscale.com'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && /^\/(?:uinv|invite|admin\/invite)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export class NetworkSetup {
  constructor({ desktop, getState, refresh, getParty, join, copy, message, isInRoom = () => false }) {
    Object.assign(this, { desktop, getState, refresh, getParty, join, copy, message, isInRoom });
    this.dialog = document.createElement('dialog'); this.dialog.id = 'connection-setup'; this.dialog.className = 'connection-setup';
    this.dialog.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">FIRST TIME ONLY</p><h2>Get your people connected.</h2></div><button id="setup-close" class="button button-muted" type="button">Close</button></div>
      <p class="setup-intro">Start here in Together. Windows handles installation approval, and your browser handles Tailscale sign-in. After that, the connection stays in the background.</p>
      <ol class="setup-steps">
        <li id="setup-install-step"><h3>Install the connection helper</h3><p id="setup-install-note">Together downloads the official Tailscale installer and checks its publisher. The app files go beside Together; Windows system components may still use C:.</p><button id="setup-install" type="button" class="button button-light">Install Tailscale</button></li>
        <li id="setup-login-step"><h3>Sign in and connect</h3><p id="setup-state">Checking this PC…</p><button id="setup-login" type="button" class="button button-light">Sign in / connect</button><p class="field-hint">Use your own account and the Personal/free plan. If you see a payment request, stop; Together never upgrades your account.</p><details class="setup-networks"><summary>Choose your friend’s network</summary><p class="field-hint">If the party PC is missing, accept the invitation in step 3, then add/sign in to that network below. Switching networks can interrupt other private connections. Leave your current Together party before switching.</p><label class="field-label" for="setup-profile">SAVED NETWORKS ON THIS PC</label><select id="setup-profile"></select><div class="setup-actions"><button id="setup-switch" class="button button-muted" type="button">Use selected network</button><button id="setup-add-network" class="button button-muted" type="button">Add / sign in to a network</button></div></details></li>
        <li><h3>Connect with your friend</h3><p>Host: open Tailscale’s Users page, choose Invite external users and copy its invitation link. This approval is needed once for each new friend.</p><button id="setup-create-invite" class="button button-muted" type="button">Create network invitation</button><label class="field-label" for="setup-network-link">NETWORK INVITATION LINK</label><input id="setup-network-link" type="url" autocomplete="off" spellcheck="false" placeholder="https://login.tailscale.com/uinv/…"><div class="setup-actions"><button id="setup-accept" class="button button-muted" type="button">Accept network invitation</button><button id="setup-copy" class="button button-muted" type="button">Copy first-time party invite</button></div><p class="field-hint">Host: the first-time invite combines network setup and the current party. Send it to one friend privately. Friend: accept it with your own account, then choose the host’s network if asked. Each new friend needs their own network invitation.</p></li>
      </ol><p id="setup-target" class="setup-target"></p><p id="setup-feedback" class="status-message" role="status"></p><div class="setup-footer"><span id="setup-auto-note">Together checks progress automatically while this panel is open.</span><button id="setup-check" class="button button-muted" type="button">Check now</button><button id="setup-done" class="button button-accent" type="button">Done</button></div>`;
    document.body.append(this.dialog);
    const $ = id => this.dialog.querySelector(`#${id}`); this.$ = $;
    $('setup-close').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => clearInterval(this.poll));
    $('setup-check').onclick = () => this.check();
    $('setup-install').onclick = () => this.action(async () => {
      if (!desktop?.installNetwork) throw new Error('Open the latest Together Windows app to install the connection helper here.');
      this.installing = true; this.render();
      try { const result = await desktop.installNetwork(); $('setup-feedback').textContent = result.message; }
      finally { this.installing = false; }
      await this.check();
    });
    $('setup-login').onclick = () => this.action(async () => { await refresh(true); this.render(); });
    $('setup-switch').onclick = () => this.action(async () => {
      if (this.isInRoom()) throw new Error('Leave your current party before switching networks.');
      if (!desktop?.switchNetwork) throw new Error('Use the latest Together desktop app to switch networks here.');
      await desktop.switchNetwork($('setup-profile').value); await this.check();
    });
    $('setup-add-network').onclick = () => this.action(async () => {
      if (this.isInRoom()) throw new Error('Leave your current party before adding another network.');
      if (!desktop?.addNetworkProfile) throw new Error('Use the latest Together desktop app to add a network here.');
      const result = await desktop.addNetworkProfile();
      $('setup-feedback').textContent = result.authUrlOpened ? 'Sign in with your own account in the browser and select your friend’s network. Then choose it from Saved networks here.' : result.message;
      await this.check();
    });
    $('setup-create-invite').onclick = () => this.action(async () => {
      if (!desktop?.openNetworkHelp) throw new Error('Network invitations are managed through the Together desktop app.');
      await desktop.openNetworkHelp();
      $('setup-feedback').textContent = 'In the Tailscale Users page, choose Invite external users → Copy invite link. Paste it here; keep the Personal/free plan.';
    });
    $('setup-accept').onclick = () => this.action(async () => {
      const url = safeNetworkInvite($('setup-network-link').value.trim());
      if (!url) throw new Error('Paste an original Tailscale network invitation link.');
      if (!desktop?.acceptNetworkInvite) throw new Error('Use the latest Together Windows app to accept network invitations.');
      await desktop.acceptNetworkInvite(url);
      $('setup-feedback').textContent = 'Accept in your browser with your own account. Select your friend’s network if asked; Together will keep checking here.';
    });
    $('setup-copy').onclick = () => this.action(async () => {
      const party = getParty();
      if (!party) throw new Error('Create or join a party first, then reopen connection setup.');
      const network = safeNetworkInvite($('setup-network-link').value.trim());
      if (!network) throw new Error('Create a network invitation and paste it above first.');
      const url = new URL(party.server); url.hash = new URLSearchParams({ code: party.code, network }).toString();
      await copy(url.href); $('setup-feedback').textContent = 'Copied one first-time invite containing network setup and this party. Send it privately to the intended friend.';
    });
    $('setup-done').onclick = () => this.action(async () => {
      const party = getParty(); this.dialog.close(); if (party) await join(party); else document.getElementById('party-name')?.focus();
    });
  }
  async action(fn) {
    if (this.actionBusy) return;
    this.actionBusy = true; this.render();
    try { await fn(); } catch (error) { this.$('setup-feedback').textContent = error.message; }
    finally { this.actionBusy = false; this.render(); }
  }
  async check() {
    if (this.checking) return; this.checking = true;
    try {
      await this.refresh(false);
      if (this.desktop?.getNetworkProfiles) {
        const profiles = await this.desktop.getNetworkProfiles();
        const previous = this.$('setup-profile').value;
        this.$('setup-profile').replaceChildren();
        for (const profile of profiles) {
          const option = new Option(`${profile.label}${profile.selected ? ' · selected' : ''}`, profile.id);
          option.selected = profile.id === previous || (!previous && profile.selected);
          this.$('setup-profile').append(option);
        }
      }
    } catch { this.$('setup-feedback').textContent = 'Could not check saved networks. Try Check now.'; }
    finally { this.checking = false; this.render(); }
  }
  open(invitation) {
    if (invitation?.network) this.$('setup-network-link').value = invitation.network;
    if (!this.dialog.open) { this.dialog.showModal(); this.$('setup-feedback').textContent = ''; }
    clearInterval(this.poll); this.poll = setInterval(() => { if (this.dialog.open && !document.hidden) void this.check(); }, 5000);
    this.render(); void this.check();
  }
  render() {
    const state = this.getState(), connected = state.state === 'connected', installed = !!state.installed;
    this.$('setup-install-step').classList.toggle('complete', installed);
    this.$('setup-login-step').classList.toggle('complete', connected);
    this.$('setup-install').disabled = installed || this.installing || this.actionBusy;
    this.$('setup-install').textContent = installed ? 'Installed' : this.installing ? 'Downloading / verifying…' : 'Install Tailscale';
    this.$('setup-login').disabled = !installed || connected || this.actionBusy;
    this.$('setup-login').textContent = connected ? 'Connected' : state.state === 'login-required' ? 'Sign in with your account' : 'Connect';
    this.$('setup-state').textContent = state.message || 'Checking this PC…';
    this.$('setup-create-invite').disabled = !connected || this.actionBusy;
    if (state.setup?.message && !installed) this.$('setup-install-note').textContent = state.setup.message;
    const party = this.getParty(); let target = '';
    if (party) {
      const host = new URL(party.server).hostname;
      const peer = (state.peers || []).find(item => item.ip === host);
      target = host === state.ip || ['localhost', '127.0.0.1'].includes(host) ? 'This PC hosts the party. Keep Together running.'
        : peer?.online ? 'The party PC is online on your private network. You can now try joining.'
          : connected ? 'The party PC is not visible yet. Accept the network invitation, choose the host’s network, and keep their PC online.' : 'Connect this PC before joining the party.';
    }
    this.$('setup-target').textContent = target;
    this.$('setup-done').disabled = (!!party && !connected) || this.actionBusy;
    this.$('setup-done').textContent = party ? 'Continue to party' : 'Done — create a party';
    this.$('setup-copy').disabled = !party || !connected || this.actionBusy;
    this.$('setup-accept').disabled = !!this.actionBusy;
    this.$('setup-switch').disabled = !this.$('setup-profile').options.length || this.isInRoom() || this.actionBusy;
    this.$('setup-add-network').disabled = !installed || this.isInRoom() || this.actionBusy;
  }
}

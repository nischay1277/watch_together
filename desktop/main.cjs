const { app, BrowserWindow, ipcMain, desktopCapturer, session, clipboard, dialog, Menu, powerSaveBlocker, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createTogetherServer } = require('../server.cjs');
const { InternetTunnel } = require('./internet.cjs');
const { PROTOCOL, parseInvitation } = require('./deep-link.cjs');

const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));
const dataRoot = process.env.TOGETHER_TEST === '1'
  ? path.join(portableRoot, 'Together-data', 'Tests', /^[a-zA-Z0-9_-]{1,80}$/.test(process.env.TOGETHER_TEST_PROFILE || '') ? process.env.TOGETHER_TEST_PROFILE : String(process.pid))
  : path.join(portableRoot, 'Together-data');
for (const folder of ['Profile', 'Browser', 'Temp', 'Crashes', 'Logs']) fs.mkdirSync(path.join(dataRoot, folder), { recursive: true });
process.env.TEMP = path.join(dataRoot, 'Temp');
process.env.TMP = path.join(dataRoot, 'Temp');
app.setPath('userData', path.join(dataRoot, 'Profile'));
app.setPath('sessionData', path.join(dataRoot, 'Browser'));
app.setPath('temp', path.join(dataRoot, 'Temp'));
app.setPath('crashDumps', path.join(dataRoot, 'Crashes'));
app.setAppLogsPath(path.join(dataRoot, 'Logs'));
// Preserve hardware acceleration. Capture and encoder limits remain hardware dependent.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let win, service, origin, pendingSource, cachedSources, sleepBlocker, tunnel, quitting = false;
let pendingInvitation = process.argv.map(parseInvitation).find(Boolean) || null;
let protocolRegistered = false;
function receiveInvitation(invitation) {
  if (!invitation) return;
  pendingInvitation = invitation;
  if (win && !win.webContents.isDestroyed()) win.webContents.send('together:open-invite', invitation);
}
app.on('open-url', (event, url) => { event.preventDefault(); receiveInvitation(parseInvitation(url)); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, commandLine) => {
    receiveInvitation(commandLine.map(parseInvitation).find(Boolean));
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(start).catch(error => {
    if (quitting) return;
    dialog.showErrorBox('Together could not start', error.message);
    app.quit();
  });
}

function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) {
    throw new Error('This action is only available in the Together window.');
  }
}

async function sources() {
  return desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 202 }, fetchWindowIcons: true });
}

async function start() {
  if (app.isPackaged && process.env.TOGETHER_TEST !== '1') {
    protocolRegistered = app.setAsDefaultProtocolClient(PROTOCOL, process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, []);
  }
  // Each app can host a LAN room; use a remote signaling URL in the UI for internet rooms.
  service = await createTogetherServer({ host: '0.0.0.0', port: 0 });
  origin = `http://127.0.0.1:${service.port}`;
  const address = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'));
  const lanOrigin = address ? `http://${address.address}:${service.port}` : origin;
  tunnel = new InternetTunnel({
    binaryPath: app.isPackaged ? path.join(process.resourcesPath, 'cloudflared.exe') : path.join(__dirname, '../vendor/cloudflared.exe'),
    origin,
    onState: state => {
      service.setPublicUrl(state.url);
      if (win && !win.webContents.isDestroyed()) win.webContents.send('together:internet-state', state);
    },
  });
  win = new BrowserWindow({
    width: 1510, height: 990, minWidth: 1000, minHeight: 730,
    backgroundColor: '#101113', title: 'Together', show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return contents === win?.webContents && requestingOrigin === origin && ['media', 'display-capture', 'fullscreen'].includes(permission);
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    let sameOrigin = false;
    try { sameOrigin = new URL(details.requestingUrl || contents.getURL()).origin === origin; } catch {}
    callback(contents === win?.webContents && sameOrigin && ['media', 'display-capture', 'fullscreen'].includes(permission));
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const selected = pendingSource;
    pendingSource = undefined;
    let trustedOrigin = false;
    try { trustedOrigin = new URL(request.securityOrigin).origin === origin; } catch {}
    if (!selected || Date.now() - selected.time > 30000 || !trustedOrigin || request.frame !== win?.webContents.mainFrame) return callback({});
    callback({ video: selected.source, ...(selected.audio && request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
  });
  ipcMain.handle('together:info', event => {
    trusted(event);
    return { version: app.getVersion(), platform: process.platform, lanOrigin, localOrigin: origin, internet: tunnel.state, dataRoot, invitation: pendingInvitation, protocolRegistered };
  });
  ipcMain.handle('together:sources', async event => {
    trusted(event);
    const available = (await sources()).filter(s => !s.name.startsWith('Together'));
    cachedSources = { time: Date.now(), byId: new Map(available.map(source => [source.id, source])) };
    return available.map(s => {
      const display = screen.getAllDisplays().find(d => String(d.id) === s.display_id);
      return {
        id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(),
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        width: display ? Math.round(display.size.width * display.scaleFactor) : null,
        height: display ? Math.round(display.size.height * display.scaleFactor) : null,
      };
    });
  });
  ipcMain.handle('together:select-source', (event, selection) => {
    trusted(event);
    const source = typeof selection?.id === 'string' && cachedSources?.byId.get(selection.id);
    if (!source || Date.now() - cachedSources.time > 300000) throw new Error('Reopen the screen picker to refresh the available windows.');
    // Reuse the explicitly previewed source. Enumerating thumbnails again here
    // can expire the click's transient permission on a busy computer.
    pendingSource = { source, audio: selection.audio === true, time: Date.now() };
    cachedSources = undefined;
    return true;
  });
  ipcMain.handle('together:clipboard', (event, value) => {
    trusted(event);
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid clipboard text.');
    clipboard.writeText(value);
  });
  ipcMain.handle('together:start-internet', event => { trusted(event); return tunnel.start(); });
  ipcMain.handle('together:stop-internet', event => { trusted(event); return tunnel.stop(); });
  win.once('ready-to-show', () => { if (process.env.TOGETHER_TEST !== '1') win.show(); });
  // Keep the live room working while the host switches to another application.
  sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  win.on('closed', () => { win = undefined; app.quit(); });
  await win.loadURL(origin);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  tunnel?.stop();
  if (sleepBlocker !== undefined && powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker);
  service?.close();
});

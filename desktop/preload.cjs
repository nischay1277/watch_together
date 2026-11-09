const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('togetherDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('together:info'),
  getSources: () => ipcRenderer.invoke('together:sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('together:select-source', { id, audio: Boolean(audio) }),
  writeClipboard: (text) => ipcRenderer.invoke('together:clipboard', text),
  startInternet: () => ipcRenderer.invoke('together:start-internet'),
  stopInternet: () => ipcRenderer.invoke('together:stop-internet'),
  onInternetState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('together:internet-state', listener);
    return () => ipcRenderer.removeListener('together:internet-state', listener);
  },
  onInvitation: callback => {
    const listener = (_event, invitation) => callback(invitation);
    ipcRenderer.on('together:open-invite', listener);
    return () => ipcRenderer.removeListener('together:open-invite', listener);
  },
}));

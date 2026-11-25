const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('togetherDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('together:info'),
  getNetworkStatus: () => ipcRenderer.invoke('together:network-status'),
  connectNetwork: () => ipcRenderer.invoke('together:network-connect'),
  openNetworkHelp: () => ipcRenderer.invoke('together:network-help'),
  installNetwork: () => ipcRenderer.invoke('together:network-install'),
  acceptNetworkInvite: url => ipcRenderer.invoke('together:network-accept-invite', url),
  getNetworkProfiles: () => ipcRenderer.invoke('together:network-profiles'),
  switchNetwork: id => ipcRenderer.invoke('together:network-switch', id),
  addNetworkProfile: () => ipcRenderer.invoke('together:network-add-profile'),
  getParties: () => ipcRenderer.invoke('together:parties'),
  saveParty: party => ipcRenderer.invoke('together:save-party', party),
  removeParty: id => ipcRenderer.invoke('together:remove-party', id),
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

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ping', {
  getState: () => ipcRenderer.invoke('getState'),
  action: (type, payload) => ipcRenderer.invoke('action', type, payload),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});

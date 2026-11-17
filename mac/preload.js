const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ping', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('getState'),
  action: (type, payload) => ipcRenderer.invoke('action', type, payload),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});

window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('os-' + process.platform));

'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', {
  onStatus: (fn) => ipcRenderer.on('status', (_e, text) => fn(String(text))),
  onNeedKey: (fn) => ipcRenderer.on('need-key', (_e, url) => fn(String(url))),
  saveKey: async (key) => { await ipcRenderer.invoke('zehnora:save-key', key); ipcRenderer.send('key-saved-notify'); },
  openPortal: () => ipcRenderer.invoke('zehnora:open-portal'),
});

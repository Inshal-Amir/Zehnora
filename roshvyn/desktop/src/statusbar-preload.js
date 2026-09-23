'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('roshvyn', {
  status: () => ipcRenderer.invoke('roshvyn:status'),
  chooseWorkspace: () => ipcRenderer.invoke('roshvyn:choose-workspace'),
  openPortal: () => ipcRenderer.invoke('roshvyn:open-portal'),
});

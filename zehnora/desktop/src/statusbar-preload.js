'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zehnora', {
  status: () => ipcRenderer.invoke('zehnora:status'),
  chooseWorkspace: () => ipcRenderer.invoke('zehnora:choose-workspace'),
  openPortal: () => ipcRenderer.invoke('zehnora:open-portal'),
});

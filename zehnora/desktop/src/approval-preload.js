'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('approval', { decide: (id, approved) => ipcRenderer.invoke('approval:decide', id, approved) });

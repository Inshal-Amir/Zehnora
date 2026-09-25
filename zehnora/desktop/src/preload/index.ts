import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, ZehnoraApi } from '../shared/types';

const api: ZehnoraApi = {
  listConversations: () => ipcRenderer.invoke('conversations:list'),
  getConversation: (id) => ipcRenderer.invoke('conversations:get', id),
  createConversation: (mode) => ipcRenderer.invoke('conversations:create', mode),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  setWorkDir: (id) => ipcRenderer.invoke('conversations:set-cwd', id),
  send: (id, text) => ipcRenderer.invoke('agent:send', id, text),
  stop: (id) => ipcRenderer.invoke('agent:stop', id),
  decide: (id, decision) => ipcRenderer.invoke('agent:decide', id, decision),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  chooseDirectory: (current) => ipcRenderer.invoke('dialog:directory', current),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  listProcesses: () => ipcRenderer.invoke('processes:list'),
  stopProcess: (id) => ipcRenderer.invoke('processes:stop', id),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  revealPath: (target) => ipcRenderer.invoke('shell:reveal', target),
  platform: process.platform,
  onEvent(listener) {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AgentEvent): void => listener(payload);
    ipcRenderer.on('zehnora:event', wrapped);
    return () => ipcRenderer.removeListener('zehnora:event', wrapped);
  },
};

contextBridge.exposeInMainWorld('zehnora', api);

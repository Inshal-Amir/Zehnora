import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, session, shell } from 'electron';
import type { AgentEvent, ApprovalDecision, Conversation, Mode, ModelStatus, SettingsPatch } from '../shared/types';
import { initShellEnvironment, listProcesses, setExtraEnv, stopAllProcesses, stopProcess, watchProcesses } from './tools/shell';
import { getSettings, readSecret, saveSettings } from './settings';
import { configureBackups } from './tools/files';
import { protectPaths } from './tools/policy';
import { Runtime } from './agent/runtime';
import { checkModel } from './llm';
import * as store from './store';

if (process.env.ZEHNORA_USER_DATA) app.setPath('userData', process.env.ZEHNORA_USER_DATA);
app.setName('Zehnora');

const RENDERER_DEV_URL = process.env.ZEHNORA_RENDERER_URL;
const RENDERER_FILE = path.join(__dirname, '../renderer/index.html');

let mainWindow: BrowserWindow | null = null;

function emit(event: AgentEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('zehnora:event', event);
}

const runtime = new Runtime({
  settings: getSettings,
  apiKey: () => readSecret('api-key'),
  save: store.save,
  emit,
});

function applyGithubToken(): void {
  const token = readSecret('github-token');
  setExtraEnv(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {});
}

function recoverInterrupted(conversation: Conversation): Conversation {
  if (runtime.isRunning(conversation.id)) return conversation;
  for (const message of conversation.messages) {
    if (message.role !== 'assistant') continue;
    if (message.streaming) {
      message.streaming = false;
      message.error ??= 'Interrupted when the app closed.';
    }
    for (const call of message.toolCalls) {
      if (call.status === 'running' || call.status === 'pending' || call.status === 'awaiting-approval') call.status = 'cancelled';
    }
  }
  return conversation;
}

function requireConversation(id: string): Conversation {
  const conversation = store.get(id);
  if (!conversation) throw new Error('Conversation not found');
  return conversation;
}

async function chooseDirectory(current?: string): Promise<string | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the working folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current ?? getSettings().defaultWorkDir,
  });
  return result.canceled || !result.filePaths[0] ? null : fs.realpathSync(result.filePaths[0]);
}

async function modelStatus(): Promise<ModelStatus> {
  const { apiBase, model } = getSettings();
  const key = readSecret('api-key');
  if (!key) return { state: 'no-key', detail: 'Add your API key in Settings' };
  const { status, models } = await checkModel(apiBase, key);
  if (status === 200) return { state: 'online', detail: models.includes(model) ? model : `${model} not listed (${models.join(', ') || 'no models'})` };
  if (status === 401 || status === 403) return { state: 'unauthorized', detail: 'The API key was rejected' };
  return { state: 'offline', detail: status ? `HTTP ${status}` : 'Cannot reach the model API' };
}

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)));
  };
  handle('conversations:list', () => store.list());
  handle('conversations:get', (id: string) => {
    const conversation = store.get(id);
    return conversation ? recoverInterrupted(conversation) : null;
  });
  handle('conversations:create', (mode: Mode) => store.create(mode, mode === 'work' ? getSettings().defaultWorkDir : undefined));
  handle('conversations:delete', (id: string) => {
    runtime.stop(id);
    runtime.approvals.forget(id);
    store.remove(id);
  });
  handle('conversations:rename', (id: string, title: string) => {
    const conversation = requireConversation(id);
    conversation.title = title.trim().slice(0, 120) || conversation.title;
    store.save(conversation);
    emit({ type: 'conversation', summary: store.summarize(conversation) });
  });
  handle('conversations:set-cwd', async (id: string) => {
    const conversation = requireConversation(id);
    const dir = await chooseDirectory(conversation.cwd);
    if (!dir) return null;
    conversation.cwd = dir;
    store.save(conversation);
    emit({ type: 'conversation', summary: store.summarize(conversation) });
    return dir;
  });
  handle('agent:send', (id: string, text: string) => {
    const conversation = requireConversation(id);
    const trimmed = text.trim();
    if (!trimmed) return;
    runtime.send(conversation, trimmed).catch((error: Error) => console.error('[zehnora] run failed', error));
  });
  handle('agent:stop', (id: string) => runtime.stop(id));
  handle('agent:decide', (id: string, decision: ApprovalDecision) => runtime.approvals.decide(id, decision));
  handle('settings:get', () => getSettings());
  handle('settings:save', (patch: SettingsPatch) => {
    const next = saveSettings(patch);
    applyGithubToken();
    nativeTheme.themeSource = next.theme;
    return next;
  });
  handle('dialog:directory', (current?: string) => chooseDirectory(current));
  handle('model:status', () => modelStatus());
  handle('processes:list', () => listProcesses());
  handle('processes:stop', (id: string) => {
    stopProcess(id);
  });
  handle('shell:open-external', (url: string) => (/^https?:\/\//i.test(url) ? shell.openExternal(url) : undefined));
  handle('shell:reveal', (target: string) => shell.showItemInFolder(target));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Zehnora',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = RENDERER_DEV_URL ? url.startsWith(RENDERER_DEV_URL) : url.startsWith('file://');
    if (allowed) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  if (RENDERER_DEV_URL) mainWindow.loadURL(RENDERER_DEV_URL);
  else mainWindow.loadFile(RENDERER_FILE);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  nativeTheme.themeSource = getSettings().theme;
  const userData = app.getPath('userData');
  protectPaths([userData]);
  configureBackups(path.join(userData, 'backups'));
  applyGithubToken();
  watchProcesses((processes) => emit({ type: 'processes', processes }));
  registerIpc();
  createWindow();
  powerSaveBlocker.start('prevent-app-suspension');
  await initShellEnvironment();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  runtime.stopAll();
  stopAllProcesses();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

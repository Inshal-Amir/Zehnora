// Roshvyn Desktop main process.
// - Checks/launches the local services (LibreChat + MongoDB + workspace connector), then opens the chat UI.
// - Hardened window: contextIsolation, no Node in renderer, sandboxed preload, navigation locked to local LibreChat.
// - Stores the Roshvyn API key with OS-backed encryption (safeStorage) and passes it only to the service process.
// - Hosts the loopback approval bridge used by the workspace connector for non-allowlisted commands.
'use strict';

const { app, BrowserWindow, WebContentsView, dialog, ipcMain, powerSaveBlocker, safeStorage, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '../../..');
const BRAND = JSON.parse(fs.readFileSync(path.join(REPO, 'roshvyn/brand/brand.json'), 'utf8'));
const LIBRECHAT_URL = process.env.ROSHVYN_LIBRECHAT_URL || 'http://127.0.0.1:3090';
const CLIENT_DATA = process.env.ROSHVYN_CLIENT_DATA || path.join(REPO, '.local-dev/client');
const APPROVAL_PORT = Number(process.env.ROSHVYN_APPROVAL_PORT || 3099);
const APPROVAL_SECRET_FILE = process.env.ROSHVYN_APPROVAL_SECRET_FILE || path.join(CLIENT_DATA, 'secrets/approval-secret');
const WORKSPACE_CONFIG = process.env.ROSHVYN_WORKSPACE_CONFIG || path.join(os.homedir(), '.roshvyn/workspace.json');
const API_BASE = process.env.ROSHVYN_API_BASE || 'http://127.0.0.1:8200/v1';
const PORTAL_URL = process.env.ROSHVYN_PORTAL_URL || 'http://127.0.0.1:5173';
const APPROVAL_TIMEOUT_MS = 120_000;
const LOCAL_ORIGIN = new URL(LIBRECHAT_URL).origin;

let mainWindow = null;
const trace = (...a) => console.log(`[roshvyn ${new Date().toISOString()}]`, ...a);
const pendingApprovals = new Map();

// ---------- helpers ----------
const keyFile = () => path.join(app.getPath('userData'), 'roshvyn-api-key.bin');

function readApiKey() {
  try {
    if (safeStorage.isEncryptionAvailable() && fs.existsSync(keyFile())) {
      return safeStorage.decryptString(fs.readFileSync(keyFile()));
    }
  } catch { /* fall through */ }
  const devFile = path.join(CLIENT_DATA, 'secrets/roshvyn-api-key');
  return fs.existsSync(devFile) ? fs.readFileSync(devFile, 'utf8').trim() : null;
}

function saveApiKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available; cannot store the key safely');
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), safeStorage.encryptString(key), { mode: 0o600 });
}

async function httpOk(url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
    return r.status;
  } catch {
    return 0;
  }
}

function readWorkspace() {
  try { return JSON.parse(fs.readFileSync(WORKSPACE_CONFIG, 'utf8')).workspace_root; } catch { return null; }
}

async function status() {
  const lc = (await httpOk(`${LIBRECHAT_URL}/health`)) === 200;
  const apiRoot = API_BASE.replace(/\/v1\/?$/, '');
  const apiHealth = await httpOk(`${apiRoot}/platform/v1/health`);
  return {
    product: BRAND.desktopName,
    librechat: lc,
    modelApi: apiHealth === 200 ? 'online' : apiHealth === 0 ? 'unreachable' : `HTTP ${apiHealth}`,
    apiBase: API_BASE,
    workspace: readWorkspace(),
    approvalBridge: approvalServer?.listening ?? false,
    keyStored: Boolean(readApiKey()),
  };
}

// ---------- service launcher ----------
async function ensureServices(splash) {
  if ((await httpOk(`${LIBRECHAT_URL}/health`)) === 200) return true;
  const key = readApiKey();
  if (!key) return false;
  const [cmd, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'roshvyn', 'scripts', 'windows', 'Start-Desktop.ps1'), '-ServicesOnly']]
    : ['bash', [path.join(REPO, 'roshvyn/scripts/mac/start-desktop.sh'), '--services-only']];
  splash?.webContents.send('status', 'Starting local services (database, LibreChat, workspace connector)…');
  await new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ROSHVYN_API_KEY: key, ROSHVYN_API_BASE: API_BASE, ROSHVYN_CLIENT_DATA: CLIENT_DATA },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => splash?.webContents.send('status', d.toString().trim()));
    child.stderr.on('data', (d) => splash?.webContents.send('status', d.toString().trim()));
    child.on('exit', resolve);
  });
  return (await httpOk(`${LIBRECHAT_URL}/health`)) === 200;
}

// ---------- approval bridge (loopback only, bearer secret) ----------
function approvalSecret() {
  if (!fs.existsSync(APPROVAL_SECRET_FILE)) {
    fs.mkdirSync(path.dirname(APPROVAL_SECRET_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(APPROVAL_SECRET_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(APPROVAL_SECRET_FILE, 'utf8').trim();
}

function logApproval(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(path.join(app.getPath('userData'), 'approvals.jsonl'), line);
}

function askApproval(req) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const win = new BrowserWindow({
      width: 560, height: 420, resizable: false, minimizable: false, alwaysOnTop: true,
      parent: mainWindow ?? undefined, modal: false, title: 'Approve command?',
      webPreferences: { preload: path.join(__dirname, 'approval-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    trace('approval requested', id, req.command.slice(0, 60));
    const finish = (approved, why) => {
      trace('approval finish', id, approved, why, 'pending:', pendingApprovals.has(id));
      if (!pendingApprovals.has(id)) return;
      pendingApprovals.delete(id);
      logApproval({ id, approved, why, command: req.command, cwd: req.cwd, shell: req.shell });
      if (!win.isDestroyed()) win.close();
      resolve(approved);
    };
    pendingApprovals.set(id, finish);
    const timer = setTimeout(() => finish(false, 'timeout'), APPROVAL_TIMEOUT_MS);
    win.on('closed', () => { clearTimeout(timer); finish(false, 'window closed'); });
    win.loadFile(path.join(__dirname, 'approval.html'), { query: { id, ...req, workspace: readWorkspace() ?? '' } });
  });
}

ipcMain.handle('approval:decide', (_e, id, approved) => {
  const finish = pendingApprovals.get(String(id));
  if (finish) finish(Boolean(approved), approved ? 'user approved' : 'user denied');
});

let approvalServer = null;
function startApprovalServer() {
  const secret = approvalSecret();
  approvalServer = http.createServer((req, res) => {
    // One-shot, long-held requests: never keep the socket alive for reuse.
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(body)); };
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${secret}`;
    if (req.method !== 'POST' || req.url !== '/approve') return reply(404, { error: 'not found' });
    if (auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
      return reply(401, { error: 'unauthorized' });
    }
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20_000) req.destroy(); });
    req.on('close', () => trace('approval http request closed; complete:', req.complete));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { error: 'bad json' }); }
      const approved = await askApproval({
        command: String(body.command ?? '').slice(0, 2000), cwd: String(body.cwd ?? '.'),
        shell: String(body.shell ?? ''), reason: String(body.reason ?? ''),
      });
      reply(200, { approved });
    });
  });
  approvalServer.listen(APPROVAL_PORT, '127.0.0.1');
  approvalServer.on('error', (err) => console.error('approval bridge failed:', err.message));
}

// ---------- windows ----------
function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

function lockNavigation(view, localFileOnly = false) {
  view.webContents.on('will-navigate', (e, url) => {
    if (localFileOnly || new URL(url).origin !== LOCAL_ORIGIN) { e.preventDefault(); if (url.startsWith('https://')) shell.openExternal(url); }
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

const STATUS_BAR_HEIGHT = 34;
let chatView = null;

// Main window = a thin Roshvyn status bar view (local HTML + narrow preload) above the LibreChat view.
// The LibreChat view has NO preload: the chat page cannot reach any Roshvyn/Electron API.
function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1320, height: 880, title: BRAND.desktopName, backgroundColor: BRAND.colors.bg, show: true });
  const bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'statusbar-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
                      backgroundThrottling: false },
  });
  chatView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.contentView.addChildView(bar);
  mainWindow.contentView.addChildView(chatView);
  const layout = () => {
    const [w, h] = mainWindow.getContentSize();
    bar.setBounds({ x: 0, y: 0, width: w, height: STATUS_BAR_HEIGHT });
    chatView.setBounds({ x: 0, y: STATUS_BAR_HEIGHT, width: w, height: Math.max(0, h - STATUS_BAR_HEIGHT) });
  };
  layout();
  mainWindow.on('resize', layout);
  lockNavigation(chatView);
  lockNavigation(bar, true);
  bar.webContents.loadFile(path.join(__dirname, 'statusbar.html'));
  chatView.webContents.loadURL(LIBRECHAT_URL);
  mainWindow.on('closed', () => { mainWindow = null; chatView = null; });
}

function createSplash() {
  const win = new BrowserWindow({
    width: 520, height: 340, frame: true, resizable: false, title: BRAND.desktopName,
    webPreferences: { preload: path.join(__dirname, 'splash-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'splash.html'));
  return win;
}

// ---------- IPC for the renderer (narrow) ----------
ipcMain.handle('roshvyn:status', () => status());
ipcMain.handle('roshvyn:choose-workspace', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the workspace folder Roshvyn may use', properties: ['openDirectory', 'createDirectory'],
    defaultPath: readWorkspace() ?? path.join(os.homedir(), 'Desktop'),
  });
  if (r.canceled || !r.filePaths[0]) return readWorkspace();
  const chosen = fs.realpathSync(r.filePaths[0]);
  if (chosen === path.parse(chosen).root || chosen === os.homedir()) {
    dialog.showErrorBox('Choose a project folder', 'The whole disk or home folder cannot be the workspace.');
    return readWorkspace();
  }
  fs.mkdirSync(path.dirname(WORKSPACE_CONFIG), { recursive: true });
  fs.writeFileSync(WORKSPACE_CONFIG, JSON.stringify({ workspace_root: chosen }) + '\n');
  return chosen;
});
ipcMain.handle('roshvyn:open-portal', () => shell.openExternal(PORTAL_URL));
ipcMain.handle('roshvyn:save-key', (_e, key) => {
  const k = String(key || '').trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(k)) throw new Error('That does not look like a Roshvyn API key (sk-…).');
  saveApiKey(k);
  return true;
});

// ---------- lifecycle ----------
app.setName(BRAND.desktopName);
// Agent runs continue while the window is in the background: stop macOS App Nap / renderer throttling
// from pausing tool calls, streaming and the approval bridge.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.whenReady().then(async () => {
  trace('app ready');
  powerSaveBlocker.start('prevent-app-suspension');
  hardenSession();
  startApprovalServer();
  trace('approval bridge listening on', APPROVAL_PORT);
  const splash = createSplash();
  await new Promise((r) => splash.webContents.once('did-finish-load', r));
  trace('splash loaded; key stored:', Boolean(readApiKey()));
  if (!readApiKey()) {
    splash.webContents.send('need-key', PORTAL_URL);
    await new Promise((r) => ipcMain.once('key-saved', r));
  }
  splash.webContents.send('status', 'Checking local services…');
  const ok = await ensureServices(splash);
  trace('services ok:', ok);
  if (!ok) {
    splash.webContents.send('status', 'Could not start local services. See the logs in ' + path.join(CLIENT_DATA, 'logs'));
    return;
  }
  createMainWindow();
  trace('main window created for', LIBRECHAT_URL);
  chatView.webContents.once('did-finish-load', () => { if (!splash.isDestroyed()) splash.close(); });
});
ipcMain.on('key-saved-notify', () => ipcMain.emit('key-saved'));
app.on('window-all-closed', () => { approvalServer?.close(); app.quit(); });

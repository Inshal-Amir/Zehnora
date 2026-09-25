import { BrowserWindow, session } from 'electron';

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  status: number;
  consoleErrors: string[];
  screenshot?: Buffer;
}

const PARTITION = 'zehnora-browse';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

let configured = false;

function browseSession(): Electron.Session {
  const browse = session.fromPartition(PARTITION);
  if (configured) return browse;
  configured = true;
  browse.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browse.setUserAgent(USER_AGENT);
  browse.on('will-download', (event) => event.preventDefault());
  return browse;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads a page in an invisible, sandboxed Chromium window (no preload, no Node) and returns the result of `extract`.
 * A real browser gets through the JavaScript checks that search engines put in front of plain HTTP clients.
 */
export async function withPage<T>(
  url: string,
  options: { timeoutMs: number; settleMs: number; screenshot?: boolean; ready?: string },
  extract: (window: BrowserWindow, snapshot: PageSnapshot) => Promise<T>,
): Promise<T> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session: browseSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, offscreen: false },
  });
  window.webContents.setAudioMuted(true);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const snapshot: PageSnapshot = { url, title: '', text: '', status: 0, consoleErrors: [] };
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error' && snapshot.consoleErrors.length < 30) snapshot.consoleErrors.push(details.message.slice(0, 400));
  });
  window.webContents.on('did-navigate', (_event, navigatedUrl, httpResponseCode) => {
    snapshot.url = navigatedUrl;
    snapshot.status = httpResponseCode;
  });
  const timer = setTimeout(() => window.webContents.stop(), options.timeoutMs);
  try {
    await window.loadURL(url).catch((error: Error) => {
      if (!/ERR_ABORTED/.test(error.message)) throw error;
    });
    const deadline = Date.now() + options.settleMs;
    await wait(Math.min(400, options.settleMs));
    while (options.ready && Date.now() < deadline) {
      const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(options.ready)}))`).catch(() => false);
      if (found) break;
      await wait(300);
    }
    if (!options.ready) await wait(Math.max(0, deadline - Date.now()));
    snapshot.title = window.webContents.getTitle();
    snapshot.text = await window.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
    if (options.screenshot) snapshot.screenshot = (await window.webContents.capturePage()).toPNG();
    return await extract(window, snapshot);
  } finally {
    clearTimeout(timer);
    window.destroy();
  }
}

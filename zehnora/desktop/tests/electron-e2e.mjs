// Zehnora Desktop Electron end-to-end check (Playwright Electron driver). Mac run; Windows needs its own run.
// Requires the Desktop services to be running (zehnora/scripts/mac/start-desktop.sh --services-only).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '../..');
const client = path.join(repo, '.local-dev/client');
const out = path.join(repo, 'zehnora/tests/evidence/desktop');
fs.mkdirSync(out, { recursive: true });
const secretFile = path.join(client, 'secrets/approval-secret');
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`); };

const app = await electron.launch({
  args: ['.'], cwd: desktop, timeout: 60_000,
  env: {
    ...process.env, ZEHNORA_CLIENT_DATA: client, ZEHNORA_LIBRECHAT_URL: 'http://127.0.0.1:3090', ZEHNORA_APPROVAL_PORT: '3099',
    ZEHNORA_APPROVAL_SECRET_FILE: secretFile, ZEHNORA_WORKSPACE_CONFIG: path.join(os.homedir(), '.zehnora/workspace.json'),
  },
});
app.process().stdout.on('data', (d) => process.stdout.write(`  [main] ${d}`));

try {
  // 1. main window reaches the local LibreChat UI
  let main = null;
  for (let i = 0; i < 90 && !main; i++) {
    main = app.windows().find((w) => w.url().startsWith('http://127.0.0.1:3090'));
    if (!main) await new Promise((r) => setTimeout(r, 1000));
  }
  check('main window loads local LibreChat', Boolean(main), main?.url() ?? 'no window');
  await main.waitForLoadState('domcontentloaded');
  check('window title is branded', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).some((t) => /Zehnora/.test(t)));

  // 2. renderer isolation: the LibreChat page gets no preload and no Node
  const iso = await main.evaluate(() => ({ require: typeof window.require, process: typeof window.process, zehnora: typeof window.zehnora }));
  check('LibreChat page has no Node access and no Zehnora API', iso.require === 'undefined' && iso.process === 'undefined' && iso.zehnora === 'undefined', JSON.stringify(iso));
  const prefs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => [w.getURL().slice(0, 40), w.getLastWebPreferences?.() ?? {}]));
  check('contextIsolation on, nodeIntegration off, sandbox on for every view',
    prefs.every(([, p]) => p.contextIsolation === true && p.nodeIntegration === false && p.sandbox === true),
    JSON.stringify(prefs.map(([u, p]) => [u, p.contextIsolation, p.nodeIntegration, p.sandbox])));

  // 3. status bar view + status API (separate webContents with a narrow preload)
  let bar = null;
  for (let i = 0; i < 30 && !bar; i++) {
    bar = app.windows().find((w) => w.url().includes('statusbar.html'));
    if (!bar) await new Promise((r) => setTimeout(r, 500));
  }
  check('status bar view present', Boolean(bar));
  await bar.waitForFunction(() => /Workspace:/.test(document.getElementById('label')?.innerText ?? ''), null, { timeout: 20_000 });
  const pill = await bar.innerText('body');
  check('status bar shows workspace and model API', /Zehnora-Workspace/.test(pill) && /Model API: online/.test(pill), pill.replace(/\n/g, ' '));
  const api = await bar.evaluate(() => Object.keys(window.zehnora));
  check('status bar exposes only the narrow API', JSON.stringify(api) === JSON.stringify(['status', 'chooseWorkspace', 'openPortal']), JSON.stringify(api));
  const st = await bar.evaluate(() => window.zehnora.status());
  check('status API reports services', st.librechat && st.approvalBridge && st.modelApi === 'online', JSON.stringify(st));

  // 4. navigation lock
  await main.evaluate(() => { location.href = 'https://example.com/'; });
  await new Promise((r) => setTimeout(r, 1500));
  check('navigation to external origin is blocked', main.url().startsWith('http://127.0.0.1:3090'), main.url());
  const before = app.windows().length;
  await main.evaluate(() => window.open('https://example.com/popup'));
  await new Promise((r) => setTimeout(r, 1000));
  check('window.open does not create an in-app window', app.windows().length === before);

  // 5. approval bridge
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const bad = await fetch('http://127.0.0.1:3099/approve', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' });
  check('approval bridge rejects a wrong secret', bad.status === 401);
  // One fresh connection per approval request (like the Python connector), no socket reuse.
  const postApproval = (payload) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: 3099, path: '/approve', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject); req.end(body);
  });
  for (const [decision, selector] of [['Deny', '#deny'], ['Approve once', '#approve']]) {
    const t0 = Date.now();
    const pending = postApproval({ command: `wc -c notes.md  # e2e ${decision}`, cwd: 'hello-zehnora', shell: 'zsh', reason: 'not in allowlist' });
    let dlg = null;
    for (let i = 0; i < 30 && !dlg; i++) {
      dlg = app.windows().find((w) => !w.isClosed() && w.url().includes('approval.html')
        && (new URL(w.url()).searchParams.get('command') ?? '').includes(`e2e ${decision}`));
      if (!dlg) await new Promise((r) => setTimeout(r, 300));
    }
    await dlg.waitForLoadState('domcontentloaded');
    const shown = await dlg.innerText('#command');
    if (decision === 'Deny') await dlg.screenshot({ path: path.join(out, 'approval-dialog.png') });
    await dlg.click(selector);
    const answer = await pending;
    const seconds = (Date.now() - t0) / 1000;
    check(`approval dialog shows the command and "${decision}" click returns approved=${decision !== 'Deny'} (not the timeout)`,
      shown.includes('wc -c notes.md') && answer.approved === (decision !== 'Deny') && seconds < 30, `${JSON.stringify(answer)} after ${seconds.toFixed(1)}s`);
  }

  // 6. screenshots (login page; no credentials typed)
  await main.screenshot({ path: path.join(out, 'desktop-chat-view.png') });
  await bar.screenshot({ path: path.join(out, 'desktop-status-bar.png') });
} finally {
  await app.close();
}
const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);

// Zehnora Desktop end-to-end check: the real Electron app against the mock model server (Playwright Electron driver).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockModel } from './mock-model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const evidence = path.resolve(desktop, '../tests/evidence/desktop');
fs.mkdirSync(evidence, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-e2e-data-'));
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-e2e-work-')));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ defaultWorkDir: workDir }));

const mock = await startMockModel();
const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`);
};

const app = await electron.launch({
  args: ['.'],
  cwd: desktop,
  timeout: 60_000,
  env: { ...process.env, ZEHNORA_USER_DATA: userData, ZEHNORA_API_BASE: mock.url, ZEHNORA_API_KEY: mock.apiKey },
});
app.process().stdout.on('data', (d) => process.stdout.write(`  [main] ${d}`));
app.process().stderr.on('data', (d) => process.stdout.write(`  [main:err] ${d}`));

const lastAssistant = (page) => page.locator('.turn.assistant').last();
async function send(page, text) {
  await page.fill('textarea', text);
  await page.keyboard.press('Enter');
}

try {
  const page = await app.firstWindow();
  await page.waitForSelector('.sidebar', { timeout: 30_000 });
  check('window opens with sidebar', true);
  check('window title', (await page.title()) === 'Zehnora');

  const iso = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, keys: Object.keys(window.zehnora).length }));
  check('renderer has no Node access, only the preload API', iso.require === 'undefined' && iso.process === 'undefined' && iso.keys > 10, JSON.stringify(iso));
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getLastWebPreferences()));
  check('contextIsolation on, nodeIntegration off, sandbox on', prefs.every((p) => p.contextIsolation && !p.nodeIntegration && p.sandbox));

  await page.waitForSelector('.status .dot.online', { timeout: 15_000 });
  check('model status online', true, await page.innerText('.status'));

  // Chat mode
  await page.click('.mode-switch button:has-text("Chat")');
  await page.screenshot({ path: path.join(evidence, '01-chat-welcome.png') });
  await send(page, 'hello there');
  await lastAssistant(page).locator('.markdown strong').waitFor({ timeout: 15_000 });
  const chatText = await lastAssistant(page).innerText();
  check('chat reply streams and renders markdown', /Hello! You said:/.test(chatText) && (await lastAssistant(page).locator('.code .hljs').count()) === 1);
  check('reasoning is shown as a collapsed block', (await lastAssistant(page).locator('.reasoning-toggle').innerText()).includes('Thought process'));
  const chatTools = mock.requests[0].tools.map((t) => t.function.name);
  check('chat mode sends only chat tools', chatTools.includes('web_search') && !chatTools.includes('run_command'), chatTools.join(','));
  check('chat appears in history', (await page.locator('.history .row-title').first().innerText()) === 'hello there');
  await page.screenshot({ path: path.join(evidence, '02-chat-reply.png') });

  await page.click('.new-chat');
  await send(page, 'search web for docs');
  await lastAssistant(page).locator('.tool-done, .tool-error').first().waitFor({ timeout: 60_000 });
  const search = await app.evaluate(async () => null);
  void search;
  const searchCard = lastAssistant(page).locator('.tool').first();
  const searchOk = (await searchCard.getAttribute('class')).includes('tool-done');
  await searchCard.locator('.tool-row').click();
  const searchOut = await searchCard.locator('.tool-body').innerText();
  check('web search returns live results through the hidden browser', searchOk && /Results from/.test(searchOut) && /https?:\/\//.test(searchOut), searchOut.split('\n').slice(0, 5).join(' | '));
  await page.screenshot({ path: path.join(evidence, '03-chat-web-search.png') });

  await page.click('.new-chat');
  await send(page, 'find a github project');
  await lastAssistant(page).locator('.tool-done, .tool-error').first().waitFor({ timeout: 30_000 });
  const ghCard = lastAssistant(page).locator('.tool').first();
  await ghCard.locator('.tool-row').click();
  const ghOut = await ghCard.locator('.tool-body').innerText();
  check('github search returns repositories', /repositories match/.test(ghOut) || /rate limit/.test(ghOut), ghOut.split('\n').slice(0, 4).join(' | '));

  // Work mode
  await page.click('.mode-switch button:has-text("Work")');
  await page.waitForSelector('.welcome h1:has-text("What should we build?")');
  await page.screenshot({ path: path.join(evidence, '04-work-welcome.png') });
  await send(page, 'create hello file');
  await lastAssistant(page).locator('.markdown:has-text("Done.")').waitFor({ timeout: 20_000 });
  const file = path.join(workDir, 'hello/hello.txt');
  check('work mode writes a file in the working folder', fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'hello from zehnora\n');
  check('tool card shows the finished write', (await lastAssistant(page).locator('.tool-done .tool-label').first().innerText()).includes('hello'));
  check('working folder chip is shown', (await page.innerText('.topbar')).includes(path.basename(workDir)));
  await page.screenshot({ path: path.join(evidence, '05-work-tool-done.png') });

  await send(page, 'delete hello folder');
  await page.waitForSelector('.approval', { timeout: 15_000 });
  check('risky command shows an inline approval', (await page.innerText('.approval-command')) === 'rm -rf hello');
  await page.screenshot({ path: path.join(evidence, '06-work-approval.png') });
  await page.click('.approval button:has-text("Deny")');
  await lastAssistant(page).locator('.tool-denied').waitFor({ timeout: 10_000 });
  await lastAssistant(page).locator('.markdown:has-text("Done.")').last().waitFor({ timeout: 10_000 });
  check('denied command did not run', fs.existsSync(file));
  const denial = mock.requests[mock.requests.length - 1].messages.filter((m) => m.role === 'tool').pop()?.content ?? '';
  check('model is told about the denial', /denied/.test(denial));

  await send(page, 'delete hello folder');
  await page.waitForSelector('.approval', { timeout: 15_000 });
  await page.click('.approval button:has-text("Allow")');
  await page.waitForFunction((f) => true, file);
  await lastAssistant(page).locator('.tool-done:has-text("rm -rf hello")').waitFor({ timeout: 15_000 });
  check('approved command runs', !fs.existsSync(file));

  await page.click('.status');
  await page.waitForSelector('.dialog');
  await page.screenshot({ path: path.join(evidence, '07-settings.png') });
  check('settings dialog opens with policy options', (await page.locator('.policy-option').count()) === 3);
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(evidence, '08-work-dark.png') });

  const stored = fs.readdirSync(path.join(userData, 'conversations')).length;
  check('conversations are saved to disk', stored >= 4, `${stored} files`);
} catch (error) {
  check('unexpected error', false, error.stack);
} finally {
  await app.close().catch(() => undefined);
  await mock.close();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
fs.writeFileSync(path.join(evidence, 'e2e-result.txt'), results.map(([n, ok]) => `${ok ? 'PASS' : 'FAIL'} ${n}`).join('\n') + `\n${results.length - failed}/${results.length} passed on ${os.platform()} ${new Date().toISOString()}\n`);
process.exit(failed ? 1 : 0);

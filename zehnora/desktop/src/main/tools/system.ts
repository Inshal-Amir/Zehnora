import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import type { Tool } from './types';
import { clip, optBool, optStr, str } from './types';
import { resolvePath } from './policy';
import { checkDestination } from './web';
import { withPage } from './browser';
import { runShell, shellName } from './shell';

const PROBES: [string, string][] = [
  ['git', 'git --version'],
  ['gh', 'gh --version'],
  ['node', 'node --version'],
  ['npm', 'npm --version'],
  ['python', process.platform === 'win32' ? 'python --version' : 'python3 --version'],
  ['uv', 'uv --version'],
  ['docker', 'docker --version'],
  ['docker daemon', 'docker info --format "{{.ServerVersion}}"'],
  ['brew', 'brew --version'],
  ['psql', 'psql --version'],
];

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

async function probeTools(signal: AbortSignal): Promise<string[]> {
  const results = await Promise.all(
    PROBES.map(async ([label, command]) => {
      const result = await runShell(command, os.homedir(), 8000, signal);
      const firstLine = result.output.trim().split('\n')[0] ?? '';
      return `${label}: ${result.exitCode === 0 && firstLine ? firstLine : 'not available'}`;
    }),
  );
  return results;
}

const systemInfo: Tool = {
  name: 'system_info',
  description: 'Describe this computer: OS, CPU, memory, free disk space, shell, and which developer tools (git, gh, node, python, docker, brew, psql) are installed and running.',
  parameters: { type: 'object', properties: {} },
  modes: ['work'],
  assess: () => ({ risk: 'safe', title: 'Check system and installed tools', detail: '', allowKey: 'system:info' }),
  async run(_args, context) {
    let disk = 'unknown';
    try {
      const stats = fs.statfsSync(os.homedir());
      disk = `${gb(stats.bavail * stats.bsize)} free of ${gb(stats.blocks * stats.bsize)}`;
    } catch {
      /* statfs is not available everywhere */
    }
    const cpus = os.cpus();
    return [
      `OS: ${os.type()} ${os.release()} (${process.platform}/${os.arch()})`,
      `CPU: ${cpus[0]?.model ?? 'unknown'} × ${cpus.length}`,
      `Memory: ${gb(os.freemem())} free of ${gb(os.totalmem())}`,
      `Disk (home): ${disk}`,
      `Home: ${os.homedir()}`,
      `Shell: ${shellName()}`,
      `Working folder: ${context.cwd}`,
      ...(await probeTools(context.signal)),
    ].join('\n');
  },
};

const openTarget: Tool = {
  name: 'open',
  description: 'Open a URL in the default browser, a file or folder with its default app, or an application by name (e.g. "Visual Studio Code", "Docker").',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string', description: 'URL, path, or application name' }, kind: { type: 'string', enum: ['url', 'path', 'app'], description: 'What target is' } },
    required: ['target', 'kind'],
  },
  modes: ['work'],
  assess: (args) => ({ risk: 'normal', title: `Open ${optStr(args, 'target')}`, detail: '', allowKey: `open:${optStr(args, 'kind')}` }),
  async run(args, context) {
    const target = str(args, 'target');
    const kind = optStr(args, 'kind', 'path');
    if (kind === 'url') {
      if (!/^https?:\/\//i.test(target)) return 'Only http(s) URLs can be opened.';
      await shell.openExternal(target);
      return `Opened ${target} in the browser.`;
    }
    if (kind === 'app') {
      const command = process.platform === 'darwin' ? `open -a ${JSON.stringify(target)}` : process.platform === 'win32' ? `Start-Process ${JSON.stringify(target)}` : `${target} &`;
      const result = await runShell(command, os.homedir(), 15_000, context.signal);
      return result.exitCode === 0 ? `Opened ${target}.` : `Could not open ${target}: ${result.output.trim()}`;
    }
    const file = resolvePath(target, context.cwd);
    const error = await shell.openPath(file);
    return error ? `Could not open ${file}: ${error}` : `Opened ${file}.`;
  },
};

const checkWebPage: Tool = {
  name: 'check_web_page',
  description: 'Load a page (for example your local dev server) in a real browser and report the title, HTTP status, console errors and visible text. Optionally saves a screenshot. Use to verify web apps you built.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Page URL, e.g. http://localhost:5173' }, screenshot: { type: 'boolean', description: 'Save a screenshot (default true)' } },
    required: ['url'],
  },
  modes: ['work'],
  assess: (args) => ({ risk: 'safe', title: `Check page ${optStr(args, 'url')}`, detail: '', allowKey: 'web' }),
  async run(args, context) {
    const url = (await checkDestination(str(args, 'url'), context.mode)).toString();
    const wantShot = optBool(args, 'screenshot', true);
    return withPage(url, { timeoutMs: 30_000, settleMs: 2500, screenshot: wantShot }, async (_window, snapshot) => {
      let shot = '';
      if (snapshot.screenshot) {
        const dir = path.join(app.getPath('userData'), 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `page-${Date.now()}.png`);
        fs.writeFileSync(file, snapshot.screenshot);
        shot = `Screenshot: ${file}`;
      }
      return [
        `URL: ${snapshot.url}`,
        `HTTP status: ${snapshot.status || 'unknown'}`,
        `Title: ${snapshot.title || '(none)'}`,
        `Console errors: ${snapshot.consoleErrors.length ? `\n- ${snapshot.consoleErrors.join('\n- ')}` : 'none'}`,
        shot,
        'Visible text:',
        clip(snapshot.text.trim() || '(page shows no text)', 6000),
      ].filter(Boolean).join('\n');
    });
  },
};

const currentTime: Tool = {
  name: 'current_time',
  description: "Get the current date, time and the user's time zone.",
  parameters: { type: 'object', properties: {} },
  modes: ['chat'],
  assess: () => ({ risk: 'safe', title: 'Check the time', detail: '', allowKey: 'time' }),
  run: async () => {
    const now = new Date();
    return `${now.toString()} (ISO ${now.toISOString()}, zone ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  },
};

export const systemTools: Tool[] = [systemInfo, openTarget, checkWebPage, currentTime];

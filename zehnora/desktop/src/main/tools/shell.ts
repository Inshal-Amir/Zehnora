import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ProcessInfo } from '../../shared/types';
import { clip } from './types';

const IS_WIN = process.platform === 'win32';
const SCRUBBED_PREFIXES = ['ZEHNORA_', 'ELECTRON_', 'CHROME_', 'GOOGLE_API_KEY'];

let loginPath: string | null = null;
let extraEnv: Record<string, string> = {};

export function shellName(): string {
  if (IS_WIN) return 'powershell';
  return (process.env.SHELL ?? '/bin/zsh').split('/').pop() ?? 'zsh';
}

function shellArgv(command: string): [string, string[]] {
  if (IS_WIN) return ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]];
  return [process.env.SHELL ?? '/bin/zsh', ['-c', command]];
}

/** GUI apps start with a minimal PATH; ask the user's login shell once so brew, nvm, pyenv and docker are found. */
export async function initShellEnvironment(): Promise<void> {
  if (IS_WIN) return;
  const shell = process.env.SHELL ?? '/bin/zsh';
  loginPath = await new Promise<string | null>((resolve) => {
    execFile(shell, ['-ilc', 'printf "__ZP__%s__ZP__" "$PATH"'], { timeout: 8000, env: { ...process.env, TERM: 'dumb' } }, (error, stdout) => {
      const match = /__ZP__(.*)__ZP__/.exec(stdout ?? '');
      resolve(error && !match ? null : (match?.[1] ?? null));
    });
  });
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', `${os.homedir()}/.local/bin`];
  const parts = new Set([...(loginPath ?? process.env.PATH ?? '').split(':'), ...extras].filter(Boolean));
  loginPath = [...parts].join(':');
}

export function setExtraEnv(env: Record<string, string>): void {
  extraEnv = env;
}

export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SCRUBBED_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) env[key] = value;
  }
  if (loginPath) env.PATH = loginPath;
  return {
    ...env,
    ...extraEnv,
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    npm_config_yes: 'true',
    DEBIAN_FRONTEND: 'noninteractive',
    PYTHONUNBUFFERED: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
  };
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      if (child.exitCode === null) process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (text: string): string => text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export function runShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
  const started = Date.now();
  const [file, args] = shellArgv(command);
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 400_000) output = output.slice(0, 20_000) + '\n…\n' + output.slice(-200_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = (): void => killTree(child);
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, extra = ''): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, output: clean(output + extra), timedOut, cancelled: signal.aborted, durationMs: Date.now() - started });
    };
    child.on('error', (error) => finish(null, `\n${error.message}`));
    child.on('close', (code) => finish(code));
  });
}

export function formatRun(result: RunResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const head = result.cancelled
    ? `Cancelled by the user after ${seconds}s.`
    : result.timedOut
      ? `Timed out after ${seconds}s and was stopped. For servers or watchers use start_process instead.`
      : `Exit code ${result.exitCode ?? 'none'} (${seconds}s).`;
  const body = result.output.trim();
  return body ? `${head}\n${clip(body)}` : `${head}\n(no output)`;
}

interface Managed {
  info: ProcessInfo;
  child: ChildProcess;
  output: string;
}

const MAX_BUFFER = 200_000;
const managed = new Map<string, Managed>();
let onChange: (processes: ProcessInfo[]) => void = () => undefined;

export function watchProcesses(listener: (processes: ProcessInfo[]) => void): void {
  onChange = listener;
}

export const listProcesses = (): ProcessInfo[] => [...managed.values()].map((entry) => ({ ...entry.info }));
const notify = (): void => onChange(listProcesses());

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function startProcess(name: string, command: string, cwd: string, port: number | null, waitMs: number, signal: AbortSignal): Promise<string> {
  const [file, args] = shellArgv(command);
  const child = spawn(file, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
  const id = `p_${crypto.randomBytes(3).toString('hex')}`;
  const entry: Managed = {
    info: { id, name, command, cwd, pid: child.pid ?? -1, running: true, exitCode: null, startedAt: Date.now() },
    child,
    output: '',
  };
  managed.set(id, entry);
  const append = (chunk: Buffer): void => {
    entry.output = (entry.output + clean(chunk.toString())).slice(-MAX_BUFFER);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (error) => append(Buffer.from(`\n${error.message}\n`)));
  child.on('close', (code) => {
    entry.info.running = false;
    entry.info.exitCode = code;
    notify();
  });
  notify();

  const deadline = Date.now() + waitMs;
  let ready = false;
  while (Date.now() < deadline && entry.info.running && !signal.aborted) {
    if (port && (await portOpen(port))) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const state = !entry.info.running
    ? `exited with code ${entry.info.exitCode}`
    : port
      ? ready ? `running; port ${port} is accepting connections` : `running; port ${port} is not open yet`
      : 'running';
  return `Process ${id} (${name}) ${state}.\nRecent output:\n${clip(entry.output.trim() || '(no output yet)', 6000)}`;
}

export function processOutput(id: string, chars: number): string {
  const entry = managed.get(id);
  if (!entry) return `No process with id ${id}. Known: ${[...managed.keys()].join(', ') || 'none'}.`;
  const state = entry.info.running ? 'running' : `exited with code ${entry.info.exitCode}`;
  return `Process ${id} (${entry.info.name}) is ${state}.\n${entry.output.slice(-chars).trim() || '(no output)'}`;
}

export function stopProcess(id: string): string {
  const entry = managed.get(id);
  if (!entry) return `No process with id ${id}.`;
  killTree(entry.child);
  entry.info.running = false;
  notify();
  return `Stopped ${id} (${entry.info.name}).`;
}

export function stopAllProcesses(): void {
  for (const entry of managed.values()) killTree(entry.child);
}

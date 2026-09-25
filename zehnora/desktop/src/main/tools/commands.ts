import fs from 'node:fs';
import type { Tool } from './types';
import { ToolError, optInt, optStr, str } from './types';
import { assessCommand, commandKey, isInside, resolvePath } from './policy';
import { formatRun, listProcesses, processOutput, runShell, shellName, startProcess, stopProcess } from './shell';

const workingDir = (value: string, cwd: string): string => {
  const dir = resolvePath(value || '.', cwd);
  if (!fs.existsSync(dir)) throw new ToolError(`Folder ${dir} does not exist; create it first.`);
  return dir;
};

const runCommand: Tool = {
  name: 'run_command',
  description:
    'Run a shell command and wait for it to finish (non-interactive; stdin is closed). Use for git, gh, docker, package managers, builds, tests, databases and system commands. ' +
    'Do not use for servers or watchers that never exit: use start_process. Read-only commands run immediately; risky ones (delete, push, sudo, system installs, unknown programs) ask the user.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line' },
      cwd: { type: 'string', description: 'Folder to run in (default: working folder)' },
      timeout_s: { type: 'integer', description: 'Timeout in seconds, 5-1800 (default 180)' },
      reason: { type: 'string', description: 'One short sentence for the user explaining why this command is needed' },
    },
    required: ['command'],
  },
  modes: ['work'],
  assess(args, context) {
    const command = str(args, 'command');
    const cwd = resolvePath(optStr(args, 'cwd', '.'), context.cwd);
    const { risk, reason } = assessCommand(command, cwd);
    const why = optStr(args, 'reason');
    return { risk, title: command, detail: `${why ? `${why}\n` : ''}Policy: ${reason}`, allowKey: `cmd:${commandKey(command)}` };
  },
  async run(args, context) {
    const cwd = workingDir(optStr(args, 'cwd', '.'), context.cwd);
    const timeout = optInt(args, 'timeout_s', 180, 5, 1800) * 1000;
    return formatRun(await runShell(str(args, 'command'), cwd, timeout, context.signal));
  },
};

const startProcessTool: Tool = {
  name: 'start_process',
  description:
    'Start a long-running command in the background (dev servers, watchers, docker compose up without -d, databases). Returns an id and the first output. ' +
    'If port is given, waits until that port accepts connections.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short label, e.g. "web dev server"' },
      command: { type: 'string', description: 'The command line' },
      cwd: { type: 'string', description: 'Folder to run in (default: working folder)' },
      port: { type: 'integer', description: 'Port the process should open (optional)' },
      wait_s: { type: 'integer', description: 'Seconds to wait for startup output, 1-120 (default 15)' },
    },
    required: ['name', 'command'],
  },
  modes: ['work'],
  assess(args, context) {
    const command = str(args, 'command');
    const { risk, reason } = assessCommand(command, resolvePath(optStr(args, 'cwd', '.'), context.cwd));
    return { risk, title: `Start in background: ${command}`, detail: `Policy: ${reason}`, allowKey: `cmd:${commandKey(command)}` };
  },
  async run(args, context) {
    const cwd = workingDir(optStr(args, 'cwd', '.'), context.cwd);
    const port = optInt(args, 'port', 0, 0, 65535) || null;
    return startProcess(str(args, 'name'), str(args, 'command'), cwd, port, optInt(args, 'wait_s', 15, 1, 120) * 1000, context.signal);
  },
};

const processOutputTool: Tool = {
  name: 'process_output',
  description: 'Show the latest output and state of a background process started with start_process.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Process id' }, chars: { type: 'integer', description: 'How many trailing characters (default 4000)' } },
    required: ['id'],
  },
  modes: ['work'],
  assess: (args) => ({ risk: 'safe', title: `Output of ${optStr(args, 'id')}`, detail: '', allowKey: 'process:read' }),
  run: async (args) => processOutput(str(args, 'id'), optInt(args, 'chars', 4000, 200, 50_000)),
};

const stopProcessTool: Tool = {
  name: 'stop_process',
  description: 'Stop a background process started with start_process (the whole process tree).',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'Process id' } }, required: ['id'] },
  modes: ['work'],
  assess: (args) => ({ risk: 'normal', title: `Stop process ${optStr(args, 'id')}`, detail: '', allowKey: 'process:stop' }),
  run: async (args) => stopProcess(str(args, 'id')),
};

const listProcessesTool: Tool = {
  name: 'list_processes',
  description: 'List background processes started in this app session.',
  parameters: { type: 'object', properties: {} },
  modes: ['work'],
  assess: () => ({ risk: 'safe', title: 'List background processes', detail: '', allowKey: 'process:read' }),
  async run(_args, context) {
    const processes = listProcesses();
    if (!processes.length) return 'No background processes.';
    return processes
      .map((p) => `${p.id}  ${p.running ? 'running' : `exited ${p.exitCode}`}  ${p.name}  (${isInside(p.cwd, context.cwd) ? p.cwd.slice(context.cwd.length) || '.' : p.cwd})  ${p.command}`)
      .join('\n');
  },
};

export const commandTools: Tool[] = [runCommand, startProcessTool, processOutputTool, stopProcessTool, listProcessesTool];
export { shellName };

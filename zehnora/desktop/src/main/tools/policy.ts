import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Risk } from '../../shared/types';

const RANK: Record<Risk, number> = { safe: 0, normal: 1, risky: 2 };
export const maxRisk = (a: Risk, b: Risk): Risk => (RANK[a] >= RANK[b] ? a : b);

const SAFE_PROGRAMS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'where', 'whereis', 'type', 'whoami', 'id', 'date',
  'uname', 'hostname', 'sw_vers', 'df', 'du', 'ps', 'uptime', 'env', 'printenv', 'file', 'stat', 'tree', 'grep', 'egrep',
  'fgrep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum', 'jq', 'lsof', 'netstat',
  'ifconfig', 'ipconfig', 'ping', 'nslookup', 'dig', 'host', 'systeminfo', 'tasklist', 'nproc', 'sysctl', 'system_profiler',
  'vm_stat', 'free', 'lscpu', 'lsblk', 'cd', 'true', 'false', 'test', 'basename', 'dirname', 'realpath', 'readlink', 'column',
  'nl', 'less', 'more', 'history', 'locale', 'cal', 'get-childitem', 'get-content', 'get-process', 'get-location',
  'test-path', 'select-string', 'get-command', 'get-item', 'get-date', 'get-computerinfo', 'dir', 'write-output',
  'write-host', 'measure-object', 'format-table', 'select-object', 'where-object', 'sort-object', 'out-string', 'sleep',
]);

const NORMAL_PROGRAMS = new Set([
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'npx', 'node', 'deno', 'bun', 'python', 'python3', 'py', 'uv', 'uvx', 'poetry',
  'pipenv', 'pytest', 'make', 'cmake', 'cargo', 'rustc', 'go', 'mvn', 'gradle', 'dotnet', 'java', 'javac', 'tsc', 'vite',
  'jest', 'vitest', 'eslint', 'prettier', 'code', 'open', 'start', 'xdg-open', 'awk', 'sed', 'tar', 'zip', 'unzip', 'gzip',
  'gunzip', 'wget', 'psql', 'mysql', 'mongosh', 'mongo', 'sqlite3', 'redis-cli', 'createdb', 'php', 'composer', 'ruby',
  'gem', 'bundle', 'rails', 'flutter', 'dart', 'swift', 'xcodebuild', 'gcc', 'g++', 'clang', 'terraform', 'kubectl', 'helm',
  'new-item', 'copy-item', 'move-item', 'set-content', 'add-content', 'out-file', 'set-location', 'expand-archive',
  'compress-archive', 'invoke-webrequest', 'invoke-restmethod', 'curl', 'http', 'ollama', 'django-admin', 'flask',
  'uvicorn', 'gunicorn', 'nodemon', 'next', 'nest', 'ng', 'vue', 'expo', 'supabase', 'vercel', 'firebase', 'prisma',
]);

const RISKY_PROGRAMS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'kill', 'killall',
  'pkill', 'taskkill', 'stop-process', 'shutdown', 'reboot', 'halt', 'launchctl', 'systemctl', 'service', 'defaults',
  'reg', 'diskutil', 'format', 'mkfs', 'dd', 'fdisk', 'mount', 'umount', 'crontab', 'scp', 'ssh', 'rsync', 'eval', 'exec',
  'set-executionpolicy', 'invoke-expression', 'iex', 'setx', 'netsh', 'sfc', 'dism', 'bcdedit', 'csrutil', 'spctl',
  'xattr', 'security', 'passwd', 'useradd', 'userdel', 'osascript', 'truncate', 'shred', 'srm', 'wipe',
]);

const SYSTEM_PACKAGE_MANAGERS = new Set(['brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'snap', 'port', 'choco', 'winget', 'scoop']);
const PACKAGE_READ_SUBCOMMANDS = new Set(['list', 'info', 'search', 'show', 'outdated', 'doctor', 'config', '--version', '-v', 'version', 'ls', 'why', 'view', 'audit']);
const NODE_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'powershell', 'pwsh', 'cmd', 'python', 'python3', 'node', 'perl', 'ruby']);

const GIT_SAFE = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'fetch', 'shortlog', 'reflog', 'grep', 'ls-remote', 'help', 'version', '--version']);
const GIT_NORMAL = new Set(['init', 'add', 'commit', 'clone', 'checkout', 'switch', 'pull', 'merge', 'stash', 'mv', 'tag', 'remote', 'config', 'submodule', 'cherry-pick', 'worktree', 'lfs', 'apply', 'am', 'notes', 'archive', 'bisect']);

const GH_SAFE = new Set(['view', 'list', 'search', 'status', 'diff', 'checks']);
const DOCKER_SAFE = new Set(['ps', 'images', 'version', 'info', 'logs', 'inspect', 'stats', 'search', 'ls', 'top', 'port', 'history', 'events', 'config', 'df', 'context']);
const DOCKER_RISKY = new Set(['rm', 'rmi', 'prune', 'kill', 'push', 'login', 'logout', 'swarm', 'secret', 'trust', 'plugin']);

const DESTRUCTIVE_SQL = /\b(drop\s+(database|table|schema|collection|user|role)|truncate\s+table|dropdatabase\s*\(|delete\s+from\s+\w+\s*(;|$))/i;

export interface CommandAssessment {
  risk: Risk;
  reason: string;
}

/** Splits a command line into simple commands at shell operators, respecting quotes. */
export function splitCommand(command: string): { segments: string[][]; pipedInto: string[][]; hasSubstitution: boolean; redirects: string[] } {
  const segments: string[][] = [];
  const pipedInto: string[][] = [];
  const redirects: string[] = [];
  let hasSubstitution = false;
  let words: string[] = [];
  let word = '';
  let quote: '"' | "'" | null = null;
  let afterPipe = false;
  let expectRedirect = false;

  const endWord = (): void => {
    if (!word) return;
    if (expectRedirect) {
      redirects.push(word);
      expectRedirect = false;
    } else {
      words.push(word);
    }
    word = '';
  };
  const endSegment = (piped: boolean): void => {
    endWord();
    if (words.length) {
      segments.push(words);
      if (afterPipe) pipedInto.push(words);
    }
    words = [];
    afterPipe = piped;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else {
        if (quote === '"' && (ch === '`' || (ch === '$' && command[i + 1] === '('))) hasSubstitution = true;
        word += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      word += command[++i];
      continue;
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) hasSubstitution = true;
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === '\n' || ch === ';') {
      endSegment(false);
      continue;
    }
    if (ch === '&' || ch === '|') {
      const doubled = command[i + 1] === ch;
      if (doubled) i++;
      if (ch === '&' && !doubled && command[i - 1] === '>') continue;
      endSegment(ch === '|' && !doubled);
      continue;
    }
    if (ch === '>' || ch === '<') {
      endWord();
      if (command[i + 1] === '>') i++;
      if (command[i + 1] === '&') {
        i++;
        continue;
      }
      if (ch === '>') expectRedirect = true;
      continue;
    }
    word += ch;
  }
  endSegment(false);
  return { segments, pipedInto, hasSubstitution, redirects };
}

const programName = (word: string): string => path.basename(word).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
const isVersionQuery = (args: string[]): boolean => args.length === 1 && ['--version', '-v', '-V', 'version', '--help', '-h', 'help'].includes(args[0]);
const firstArg = (args: string[]): string => args.find((arg) => !arg.startsWith('-')) ?? args[0] ?? '';

function assessGit(args: string[]): Risk {
  const sub = firstArg(args);
  if (sub === 'push' || sub === 'clean' || sub === 'rebase' || sub === 'filter-branch' || sub === 'rm' || sub === 'restore') return 'risky';
  if (sub === 'reset') return args.includes('--hard') ? 'risky' : 'normal';
  if (sub === 'branch') return args.some((arg) => /^-[dD]$|^--delete$/.test(arg)) ? 'risky' : args.length === 1 || args.includes('-a') || args.includes('--list') ? 'safe' : 'normal';
  if (sub === 'checkout' && args.includes('--')) return 'risky';
  if (sub === 'remote') return args.length <= 2 && (args.includes('-v') || args.length === 1) ? 'safe' : 'normal';
  if (sub === 'config') return args.some((arg) => arg === '--get' || arg === '--list' || arg === '-l') ? 'safe' : 'normal';
  if (sub === 'stash') return args[1] === 'list' || args[1] === 'show' ? 'safe' : args[1] === 'drop' || args[1] === 'clear' ? 'risky' : 'normal';
  if (GIT_SAFE.has(sub)) return 'safe';
  if (GIT_NORMAL.has(sub)) return 'normal';
  return 'risky';
}

function assessGh(args: string[]): Risk {
  const [group, action] = args.filter((arg) => !arg.startsWith('-'));
  if (group === 'search' || group === 'status' || isVersionQuery(args)) return 'safe';
  if (group === 'auth') return action === 'status' ? 'safe' : 'risky';
  if (group === 'api') return args.some((arg) => /^(-X|--method)$/.test(arg) || /^-(f|F)$|^--(field|raw-field|input)$/.test(arg)) ? 'risky' : 'safe';
  if (group === 'repo' && action === 'clone') return 'normal';
  if (action && GH_SAFE.has(action)) return 'safe';
  return 'risky';
}

function assessDocker(args: string[]): Risk {
  const words = args.filter((arg) => !arg.startsWith('-'));
  const sub = words[0] === 'compose' || words[0] === 'container' || words[0] === 'image' || words[0] === 'volume' || words[0] === 'network' || words[0] === 'system' ? words[1] ?? '' : words[0] ?? '';
  if (words[0] === 'compose' && sub === 'down') return args.some((arg) => arg === '-v' || arg === '--volumes' || arg === '--rmi') ? 'risky' : 'normal';
  if (isVersionQuery(args) || DOCKER_SAFE.has(sub)) return 'safe';
  if (DOCKER_RISKY.has(sub) || (words[0] === 'volume' && sub === 'rm')) return 'risky';
  if (args.includes('--privileged') || args.some((arg) => /^(-v|--volume)$/.test(arg)) && args.some((arg) => /^\/(:|$)|^\/(etc|var\/run\/docker\.sock)/.test(arg))) return 'risky';
  return 'normal';
}

function assessNodePackageManager(args: string[]): Risk {
  if (args.some((arg) => arg === '-g' || arg === '--global' || arg === '--location=global')) return 'risky';
  const sub = firstArg(args);
  if (sub === 'publish' || sub === 'unpublish' || sub === 'login' || sub === 'adduser' || sub === 'owner' || sub === 'token' || sub === 'deprecate') return 'risky';
  if (PACKAGE_READ_SUBCOMMANDS.has(sub) || isVersionQuery(args)) return 'safe';
  return 'normal';
}

function assessPip(args: string[]): Risk {
  const sub = firstArg(args);
  if (PACKAGE_READ_SUBCOMMANDS.has(sub) || sub === 'freeze' || isVersionQuery(args)) return 'safe';
  if (args.includes('--break-system-packages')) return 'risky';
  return 'normal';
}

function assessFind(args: string[]): Risk {
  if (args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir' || arg === '-ok' || arg === '-okdir')) return 'risky';
  return 'safe';
}

function assessProgram(words: string[]): { risk: Risk; program: string } {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  const raw = words[index] ?? '';
  const program = programName(raw);
  const args = words.slice(index + 1);
  if (!program) return { risk: 'safe', program };
  if (program === 'timeout' || program === 'time' || program === 'nice' || program === 'nohup') return assessProgram(args);
  if (RISKY_PROGRAMS.has(program)) return { risk: 'risky', program };
  if (program === 'git') return { risk: assessGit(args), program };
  if (program === 'gh') return { risk: assessGh(args), program };
  if (program === 'docker' || program === 'docker-compose' || program === 'podman') return { risk: assessDocker(program === 'docker-compose' ? ['compose', ...args] : args), program };
  if (NODE_PACKAGE_MANAGERS.has(program)) return { risk: assessNodePackageManager(args), program };
  if (program === 'pip' || program === 'pip3') return { risk: assessPip(args), program };
  if (SYSTEM_PACKAGE_MANAGERS.has(program)) return { risk: PACKAGE_READ_SUBCOMMANDS.has(firstArg(args)) ? 'safe' : 'risky', program };
  if (program === 'find') return { risk: assessFind(args), program };
  if (INTERPRETERS.has(program) && args.some((arg) => /^(-c|-e|--eval|-command|-encodedcommand|\/c)$/i.test(arg))) return { risk: 'risky', program };
  if (program === 'sed' && !args.some((arg) => arg.startsWith('-i'))) return { risk: 'safe', program };
  if (isVersionQuery(args)) return { risk: 'safe', program };
  if (SAFE_PROGRAMS.has(program)) return { risk: 'safe', program };
  if (NORMAL_PROGRAMS.has(program) || INTERPRETERS.has(program)) return { risk: 'normal', program };
  if (raw.startsWith('./') || raw.startsWith('.\\')) return { risk: 'normal', program };
  return { risk: 'risky', program };
}

const SUBCOMMAND_CLIS = new Set(['git', 'gh', 'docker', 'docker-compose', 'podman', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'brew', 'apt', 'apt-get', 'winget', 'choco', 'kubectl', 'helm', 'cargo', 'go', 'dotnet', 'poetry', 'terraform', 'supabase', 'vercel', 'firebase', 'prisma']);

/**
 * Key for "always allow in this chat": every program in the command line (plus the sub-command for CLIs like git
 * or docker), so allowing `git commit` never also allows `git commit && rm -rf x`.
 */
export function commandKey(command: string): string {
  const { segments, hasSubstitution } = splitCommand(command);
  const parts = segments.map((words) => {
    let index = 0;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
    const program = programName(words[index] ?? '');
    const sub = words.slice(index + 1).find((arg) => !arg.startsWith('-')) ?? '';
    const compose = program === 'docker' && sub === 'compose' ? ` ${words.slice(index + 2).find((arg) => !arg.startsWith('-')) ?? ''}` : '';
    return SUBCOMMAND_CLIS.has(program) ? `${program} ${sub}${compose}` : program;
  });
  return `${parts.join(' + ')}${hasSubstitution ? ' + $()' : ''}`;
}

const REDIRECT_SINKS = new Set(['/dev/null', 'nul', '$null', '&1', '&2']);

export function assessCommand(command: string, cwd: string): CommandAssessment {
  const { segments, pipedInto, hasSubstitution, redirects } = splitCommand(command);
  if (!segments.length) return { risk: 'safe', reason: 'empty command' };
  let risk: Risk = 'safe';
  const reasons: string[] = [];
  for (const words of segments) {
    const assessed = assessProgram(words);
    if (assessed.risk !== 'safe') reasons.push(`${assessed.program}: ${assessed.risk}`);
    risk = maxRisk(risk, assessed.risk);
  }
  if (pipedInto.some((words) => INTERPRETERS.has(programName(words[0] ?? '')))) {
    risk = 'risky';
    reasons.push('output is piped into an interpreter');
  }
  if (hasSubstitution) {
    risk = 'risky';
    reasons.push('uses command substitution');
  }
  for (const target of redirects) {
    if (REDIRECT_SINKS.has(target.toLowerCase())) continue;
    const inside = isInside(resolvePath(target, cwd), cwd);
    risk = maxRisk(risk, inside ? 'normal' : 'risky');
    reasons.push(`writes to ${target}`);
  }
  if (DESTRUCTIVE_SQL.test(command)) {
    risk = 'risky';
    reasons.push('destructive database statement');
  }
  return { risk, reason: reasons.join('; ') || 'read-only command' };
}

export function resolvePath(target: string, cwd: string): string {
  const expanded = target === '~' ? os.homedir() : target.startsWith('~/') || target.startsWith('~\\') ? path.join(os.homedir(), target.slice(2)) : target;
  return path.resolve(cwd, expanded);
}

export function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const HOME_SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.config/gcloud', '.config/gh', '.docker/config.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'Library/Keychains', 'Library/Cookies', 'AppData/Roaming/Microsoft/Credentials'];
const SYSTEM_ROOTS = process.platform === 'win32'
  ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
  : ['/etc', '/private/etc', '/System', '/usr', '/bin', '/sbin', '/Library', '/var', '/private/var', '/boot', '/dev', '/proc', '/sys'];

const TEMP_ROOTS = [...new Set([os.tmpdir(), realpathOr(os.tmpdir()), '/tmp', '/private/tmp'])];

function realpathOr(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

let protectedRoots: string[] = [];

/** Folders holding the app's own secrets and history; tools must never touch them without approval. */
export function protectPaths(roots: string[]): void {
  protectedRoots = roots;
}

const ENV_FILE = /(^|[\\/])\.env(\.[\w-]+)?$/;
const ENV_TEMPLATE = /\.env\.(example|sample|template)$/;

/** Secrets and system folders. A project's own `.env` inside the working folder is not sensitive. */
export function isSensitivePath(target: string, cwd: string): boolean {
  const home = os.homedir();
  if (HOME_SENSITIVE.some((entry) => isInside(target, path.join(home, entry)))) return true;
  if (protectedRoots.some((root) => isInside(target, root))) return true;
  if (ENV_FILE.test(target) && !ENV_TEMPLATE.test(target) && !isInside(target, cwd)) return true;
  if (TEMP_ROOTS.some((root) => isInside(target, root))) return false;
  return SYSTEM_ROOTS.some((root) => isInside(target, root));
}

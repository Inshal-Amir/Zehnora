import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { Risk } from '../../shared/types';
import type { Args, Assessment, Tool, ToolContext } from './types';
import { isInside, isSensitivePath, resolvePath } from './policy';
import { ToolError, clip, optBool, optInt, optStr, str } from './types';

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', '.turbo', 'target', '.idea', '.gradle', 'Pods', '.DS_Store']);
const MAX_READ_CHARS = 60_000;
const MAX_WRITE_BYTES = 5_000_000;

let backupRoot = '';

export function configureBackups(dir: string): void {
  backupRoot = dir;
}

const target = (args: Args, key: string, context: ToolContext): string => resolvePath(str(args, key), context.cwd);
const shown = (file: string, context: ToolContext): string => (isInside(file, context.cwd) ? path.relative(context.cwd, file) || '.' : file);

function readRisk(file: string, context: ToolContext): Risk {
  return isSensitivePath(file, context.cwd) ? 'risky' : 'safe';
}

function writeRisk(file: string, context: ToolContext): Risk {
  if (isSensitivePath(file, context.cwd)) return 'risky';
  return isInside(file, context.cwd) ? 'normal' : 'risky';
}

function assessPath(kind: 'read' | 'write', title: string, key = 'path') {
  return (args: Args, context: ToolContext): Assessment => {
    const file = target(args, key, context);
    return {
      risk: kind === 'read' ? readRisk(file, context) : writeRisk(file, context),
      title: `${title} ${shown(file, context)}`,
      detail: file,
      allowKey: `${kind}:${path.dirname(file)}`,
    };
  };
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

function backup(file: string): void {
  if (!backupRoot || !fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, stamp, path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

function writeText(file: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw new ToolError('Content is larger than 5 MB; write it in parts.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, content);
}

const lineCount = (text: string): number => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0);

const formatSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

function listTree(dir: string, depth: number, limit: number): string[] {
  const lines: string[] = [];
  const walk = (current: string, level: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      lines.push(`${'  '.repeat(level)}(cannot read: ${(error as Error).message})`);
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= limit) return;
      const indent = '  '.repeat(level);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const skipped = SKIP_DIRS.has(entry.name);
        lines.push(`${indent}${entry.name}/${skipped ? ' (not expanded)' : ''}`);
        if (!skipped && level + 1 < depth) walk(full, level + 1);
        continue;
      }
      let size = '';
      try {
        size = formatSize(fs.statSync(full).size);
      } catch {
        size = '?';
      }
      lines.push(`${indent}${entry.name}${entry.isSymbolicLink() ? ' -> link' : ''}  ${size}`);
    }
  };
  walk(dir, 0);
  if (lines.length >= limit) lines.push(`… (stopped after ${limit} entries)`);
  return lines;
}

function* walkFiles(root: string): Generator<string> {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '{') source += '(';
    else if (ch === '}') source += ')';
    else if (ch === ',') source += '|';
    else source += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${source}$`, 'i');
}

function matcher(pattern: string): (relative: string) => boolean {
  const regex = globToRegExp(pattern.replace(/\\/g, '/'));
  const matchBase = !pattern.includes('/');
  return (relative) => {
    const normalized = relative.replace(/\\/g, '/');
    return regex.test(matchBase ? path.posix.basename(normalized) : normalized);
  };
}

const readFile: Tool = {
  name: 'read_file',
  description: 'Read a text file. Paths may be absolute, ~/…, or relative to the working folder. Use offset/limit (line numbers, 1-based) for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      offset: { type: 'integer', description: 'First line to return (1-based, default 1)' },
      limit: { type: 'integer', description: 'Maximum number of lines (default 800)' },
    },
    required: ['path'],
  },
  modes: ['work'],
  assess: assessPath('read', 'Read'),
  async run(args, context) {
    const file = target(args, 'path', context);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) throw new ToolError(`${file} is a folder; use list_directory.`);
    const buffer = fs.readFileSync(file);
    if (isBinary(buffer)) return `${file} is a binary file (${formatSize(stat.size)}); it cannot be shown as text.`;
    const lines = buffer.toString('utf8').split('\n');
    const offset = optInt(args, 'offset', 1, 1, Math.max(1, lines.length));
    const limit = optInt(args, 'limit', 800, 1, 5000);
    const slice = lines.slice(offset - 1, offset - 1 + limit).join('\n');
    const end = Math.min(lines.length, offset - 1 + limit);
    const header = `${shown(file, context)}: lines ${offset}-${end} of ${lines.length}`;
    const body = slice.length > MAX_READ_CHARS ? `${slice.slice(0, MAX_READ_CHARS)}\n… [truncated; read a smaller range]` : slice;
    return `${header}\n${body}`;
  },
};

const writeFile: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a text file with the full content. Parent folders are created. Existing files are backed up first. Prefer edit_file for small changes to existing files.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'File path' }, content: { type: 'string', description: 'Complete file content' } },
    required: ['path', 'content'],
  },
  modes: ['work'],
  assess: assessPath('write', 'Write'),
  async run(args, context) {
    const file = target(args, 'path', context);
    const content = optStr(args, 'content');
    const existed = fs.existsSync(file);
    writeText(file, content);
    return `${existed ? 'Overwrote' : 'Created'} ${shown(file, context)} (${lineCount(content)} lines, ${formatSize(Buffer.byteLength(content))}).`;
  },
};

const editFile: Tool = {
  name: 'edit_file',
  description: 'Replace an exact piece of text in a file. old_text must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_text: { type: 'string', description: 'Exact text to replace' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  modes: ['work'],
  assess: assessPath('write', 'Edit'),
  async run(args, context) {
    const file = target(args, 'path', context);
    const oldText = str(args, 'old_text');
    const newText = optStr(args, 'new_text');
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      const trimmed = oldText.trim();
      const hint = trimmed && text.includes(trimmed) ? ' The text exists with different surrounding whitespace; copy it exactly from read_file.' : ' Read the file again and copy the exact text.';
      throw new ToolError(`old_text was not found in ${shown(file, context)}.${hint}`);
    }
    const all = optBool(args, 'replace_all');
    if (count > 1 && !all) throw new ToolError(`old_text appears ${count} times; add surrounding lines to make it unique or set replace_all.`);
    const next = all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    writeText(file, next);
    return `Edited ${shown(file, context)}: replaced ${all ? count : 1} occurrence(s).`;
  },
};

const listDirectory: Tool = {
  name: 'list_directory',
  description: 'List a folder as a tree (folders first, with file sizes). Heavy folders like node_modules and .git are not expanded.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Folder path (default: working folder)' }, depth: { type: 'integer', description: 'Levels to expand, 1-5 (default 2)' } },
  },
  modes: ['work'],
  assess(args, context) {
    const dir = resolvePath(optStr(args, 'path', '.'), context.cwd);
    return { risk: readRisk(dir, context), title: `List ${shown(dir, context)}`, detail: dir, allowKey: `read:${dir}` };
  },
  async run(args, context) {
    const dir = resolvePath(optStr(args, 'path', '.'), context.cwd);
    if (!fs.existsSync(dir)) throw new ToolError(`${dir} does not exist.`);
    const lines = listTree(dir, optInt(args, 'depth', 2, 1, 5), 400);
    return `${dir}\n${lines.join('\n') || '(empty)'}`;
  },
};

const findFiles: Tool = {
  name: 'find_files',
  description: 'Find files by glob pattern, e.g. "*.tsx", "src/**/*.py", "package.json". Returns paths relative to the search folder.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Glob pattern' }, path: { type: 'string', description: 'Folder to search (default: working folder)' } },
    required: ['pattern'],
  },
  modes: ['work'],
  assess(args, context) {
    const dir = resolvePath(optStr(args, 'path', '.'), context.cwd);
    return { risk: readRisk(dir, context), title: `Find ${optStr(args, 'pattern')} in ${shown(dir, context)}`, detail: dir, allowKey: `read:${dir}` };
  },
  async run(args, context) {
    const dir = resolvePath(optStr(args, 'path', '.'), context.cwd);
    const matches = matcher(str(args, 'pattern'));
    const found: string[] = [];
    for (const file of walkFiles(dir)) {
      const relative = path.relative(dir, file);
      if (matches(relative)) found.push(relative);
      if (found.length >= 300) break;
    }
    return found.length ? `${found.length}${found.length >= 300 ? '+' : ''} file(s) in ${dir}:\n${found.sort().join('\n')}` : `No files matching ${str(args, 'pattern')} in ${dir}.`;
  },
};

const searchText: Tool = {
  name: 'search_text',
  description: 'Search file contents for a regular expression (or plain text). Returns file:line: text for each match.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Regular expression or text' },
      path: { type: 'string', description: 'Folder or file to search (default: working folder)' },
      glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts"' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive (default true)' },
    },
    required: ['query'],
  },
  modes: ['work'],
  assess(args, context) {
    const dir = resolvePath(optStr(args, 'path', '.'), context.cwd);
    return { risk: readRisk(dir, context), title: `Search "${optStr(args, 'query')}" in ${shown(dir, context)}`, detail: dir, allowKey: `read:${dir}` };
  },
  async run(args, context) {
    const root = resolvePath(optStr(args, 'path', '.'), context.cwd);
    const query = str(args, 'query');
    const flags = optBool(args, 'ignore_case', true) ? 'i' : '';
    let regex: RegExp;
    try {
      regex = new RegExp(query, flags);
    } catch {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    const glob = optStr(args, 'glob');
    const include = glob ? matcher(glob) : () => true;
    const files = fs.statSync(root).isFile() ? [root] : walkFiles(root);
    const results: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file) || path.basename(file);
      if (!include(relative)) continue;
      let buffer: Buffer;
      try {
        if (fs.statSync(file).size > 1_000_000) continue;
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (isBinary(buffer)) continue;
      const lines = buffer.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && results.length < 200; i++) {
        if (regex.test(lines[i])) results.push(`${relative}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
      }
      if (results.length >= 200) break;
    }
    return results.length ? clip(results.join('\n')) : `No matches for ${query}.`;
  },
};

const createDirectory: Tool = {
  name: 'create_directory',
  description: 'Create a folder (and any missing parent folders).',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path' } }, required: ['path'] },
  modes: ['work'],
  assess: assessPath('write', 'Create folder'),
  async run(args, context) {
    const dir = target(args, 'path', context);
    fs.mkdirSync(dir, { recursive: true });
    return `Folder ready: ${dir}`;
  },
};

const movePath: Tool = {
  name: 'move_path',
  description: 'Move or rename a file or folder. Fails if the destination already exists.',
  parameters: {
    type: 'object',
    properties: { source: { type: 'string', description: 'Current path' }, destination: { type: 'string', description: 'New path' } },
    required: ['source', 'destination'],
  },
  modes: ['work'],
  assess(args, context) {
    const from = target(args, 'source', context);
    const to = target(args, 'destination', context);
    const risk: Risk = writeRisk(from, context) === 'normal' && writeRisk(to, context) === 'normal' ? 'normal' : 'risky';
    return { risk, title: `Move ${shown(from, context)} → ${shown(to, context)}`, detail: `${from}\n→ ${to}`, allowKey: `move:${path.dirname(from)}` };
  },
  async run(args, context) {
    const from = target(args, 'source', context);
    const to = target(args, 'destination', context);
    if (fs.existsSync(to)) throw new ToolError(`${to} already exists.`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return `Moved ${from} → ${to}`;
  },
};

const deletePath: Tool = {
  name: 'delete_path',
  description: 'Move a file or folder to the Trash / Recycle Bin (recoverable). Always asks the user first.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to delete' } }, required: ['path'] },
  modes: ['work'],
  assess(args, context) {
    const file = target(args, 'path', context);
    return { risk: 'risky', title: `Move to Trash: ${shown(file, context)}`, detail: file, allowKey: `delete:${file}` };
  },
  async run(args, context) {
    const file = target(args, 'path', context);
    if (!fs.existsSync(file)) throw new ToolError(`${file} does not exist.`);
    if (file === path.parse(file).root || file === context.cwd) throw new ToolError('Refusing to delete a drive root or the working folder itself.');
    await shell.trashItem(file);
    return `Moved to Trash: ${file}`;
  },
};

export const fileTools: Tool[] = [readFile, writeFile, editFile, listDirectory, findFiles, searchText, createDirectory, movePath, deletePath];

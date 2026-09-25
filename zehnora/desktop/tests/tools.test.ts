import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/main/tools/types';
import { buildMessages } from '../src/main/agent/context';
import { toolsFor } from '../src/main/tools';
import { htmlToText } from '../src/main/tools/web';

let dir: string;
let context: ToolContext;
const tools = toolsFor('work');
const run = (name: string, args: Record<string, string | number | boolean>): Promise<string> => tools.get(name)!.run(args, context);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-tools-')));
  context = { conversationId: 'c', mode: 'work', cwd: dir, signal: new AbortController().signal };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('file tools', () => {
  it('writes, reads ranges and edits exactly', async () => {
    await run('write_file', { path: 'src/a.ts', content: 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n' });
    expect(await run('read_file', { path: 'src/a.ts', offset: 2, limit: 1 })).toBe('src/a.ts: lines 2-2 of 4\nconst b = 2;');
    await expect(run('edit_file', { path: 'src/a.ts', old_text: ' = 1;', new_text: ' = 9;' })).rejects.toThrow(/2 times/);
    await run('edit_file', { path: 'src/a.ts', old_text: 'const b = 2;', new_text: 'const b = 3;' });
    expect(fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')).toContain('const b = 3;');
    await expect(run('edit_file', { path: 'src/a.ts', old_text: 'missing', new_text: 'x' })).rejects.toThrow(/not found/);
  });

  it('lists, finds and searches while skipping node_modules', async () => {
    await run('write_file', { path: 'web/src/App.tsx', content: 'export const App = () => "TODO: title";\n' });
    await run('write_file', { path: 'web/node_modules/x/index.js', content: 'TODO\n' });
    expect(await run('find_files', { pattern: '*.tsx' })).toContain(path.join('web', 'src', 'App.tsx'));
    const found = await run('search_text', { query: 'TODO' });
    expect(found).toContain('App.tsx:1:');
    expect(found).not.toContain('node_modules');
    const tree = await run('list_directory', { path: 'web', depth: 3 });
    expect(tree).toContain('node_modules/ (not expanded)');
  });

  it('rates writes outside the working folder as risky', () => {
    const write = tools.get('write_file')!;
    expect(write.assess({ path: 'inside.txt', content: '' }, context).risk).toBe('normal');
    expect(write.assess({ path: path.join(os.homedir(), 'Desktop', 'x.txt'), content: '' }, context).risk).toBe('risky');
    expect(tools.get('read_file')!.assess({ path: '~/.ssh/id_ed25519' }, context).risk).toBe('risky');
    expect(tools.get('delete_path')!.assess({ path: 'inside.txt' }, context).risk).toBe('risky');
  });

  it('moves deleted files away', async () => {
    await run('write_file', { path: 'old.txt', content: 'x' });
    await run('delete_path', { path: 'old.txt' });
    expect(fs.existsSync(path.join(dir, 'old.txt'))).toBe(false);
  });
});

describe('processes', () => {
  it('starts a server in the background, waits for its port and stops it', async () => {
    const port = 40000 + Math.floor(Math.random() * 2000);
    await run('write_file', { path: 'server.js', content: `require('http').createServer((q, s) => s.end('ok')).listen(${port}, () => console.log('listening ${port}'));` });
    const started = await run('start_process', { name: 'test server', command: 'node server.js', port, wait_s: 15 });
    expect(started).toMatch(/accepting connections/);
    const id = /Process (p_\w+)/.exec(started)![1];
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('ok');
    expect(await run('process_output', { id })).toContain(`listening ${port}`);
    await run('stop_process', { id });
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`).then(() => 'up', () => 'down'), { timeout: 8000 }).toBe('down');
  });
});

describe('context budget', () => {
  it('drops old steps but keeps the task and tool pairs intact', () => {
    const big = 'x'.repeat(20_000);
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'the task', createdAt: 0 },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `a${i}`, role: 'assistant' as const, content: '', reasoning: '', createdAt: 0,
        toolCalls: [{ id: `t${i}`, name: 'read_file', arguments: '{}', status: 'done' as const, result: big }],
      })),
    ];
    const built = buildMessages('system', messages, [], 30_000, 2000);
    expect(built[0]).toEqual({ role: 'system', content: 'system' });
    expect(built[1]).toEqual({ role: 'user', content: 'the task' });
    const size = built.reduce((sum, m) => sum + JSON.stringify(m).length, 0) / 3.2;
    expect(size).toBeLessThan(30_000);
    const ids = new Set(built.flatMap((m) => (m.role === 'assistant' ? m.tool_calls?.map((c) => c.id) ?? [] : [])));
    for (const m of built) if (m.role === 'tool') expect(ids.has(m.tool_call_id)).toBe(true);
  });
});

describe('html to text', () => {
  it('keeps headings, list items and decodes entities', () => {
    const { title, text } = htmlToText('<html><head><title>A &amp; B</title><style>x{}</style></head><body><h2>Intro</h2><p>Tom &quot;Jerry&quot;</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script></body></html>');
    expect(title).toBe('A & B');
    expect(text).toBe('## Intro\nTom "Jerry"\n• one\n• two');
  });
});

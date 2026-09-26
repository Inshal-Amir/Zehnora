import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AssistantMessage, Conversation, Settings } from '../src/shared/types';
import type { MockModel, MockReply, MockRequest } from './mock-model.mjs';
import { Runtime } from '../src/main/agent/runtime';
import { startMockModel } from './mock-model.mjs';

let mock: MockModel;
let workDir: string;
let events: AgentEvent[];
let settings: Settings;

function makeRuntime(): Runtime {
  return new Runtime({ settings: () => settings, apiKey: () => mock.apiKey, save: () => undefined, emit: (event) => events.push(event) });
}

function conversation(mode: 'chat' | 'work' = 'work'): Conversation {
  return { id: '00000000-0000-4000-8000-000000000001', mode, title: 'New chat', cwd: workDir, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
}

const assistantSteps = (c: Conversation): AssistantMessage[] => c.messages.filter((m): m is AssistantMessage => m.role === 'assistant');
const toolResults = (body: MockRequest): string[] => body.messages.filter((m) => m.role === 'tool').map((m) => m.content ?? '');

async function withScript(script: MockReply[]): Promise<void> {
  mock = await startMockModel((_body, count) => script[Math.min(count, script.length) - 1]);
}

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zehnora-work-')));
  events = [];
  settings = { apiBase: '', consoleBase: '', accountEmail: '', model: 'zehnora-coder', hasApiKey: true, hasGithubToken: false, approvalPolicy: 'risky', defaultWorkDir: workDir, searxngUrl: '', contextTokens: 60000, maxOutputTokens: 2048, theme: 'system' };
});

afterEach(async () => {
  await mock?.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('agent runtime', () => {
  it('runs tools in a loop and feeds results back to the model', async () => {
    await withScript([
      { content: 'Creating the file.', tool_calls: [{ name: 'write_file', arguments: JSON.stringify({ path: 'app/hello.txt', content: 'hi there\n' }) }] },
      { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: process.platform === 'win32' ? 'Get-Content app/hello.txt' : 'cat app/hello.txt' }) }] },
      { content: 'All done.' },
    ]);
    settings.apiBase = mock.url;
    const c = conversation();
    await makeRuntime().send(c, 'make a hello file');

    expect(fs.readFileSync(path.join(workDir, 'app/hello.txt'), 'utf8')).toBe('hi there\n');
    const steps = assistantSteps(c);
    expect(steps).toHaveLength(3);
    expect(steps[0].toolCalls[0]).toMatchObject({ name: 'write_file', status: 'done', risk: 'normal' });
    expect(steps[1].toolCalls[0]).toMatchObject({ name: 'run_command', status: 'done', risk: 'safe' });
    expect(steps[1].toolCalls[0].result).toContain('hi there');
    expect(steps[2].content).toBe('All done.');
    expect(toolResults(mock.requests[2]).join('\n')).toContain('hi there');
    expect(c.title).toBe('make a hello file');
    expect(mock.requests[0].tools?.map((tool) => tool.function.name)).toContain('run_command');
    expect(events.some((event) => event.type === 'run-state' && !event.running)).toBe(true);
  });

  it('asks before a risky command and tells the model when it is denied', async () => {
    fs.mkdirSync(path.join(workDir, 'keep'));
    await withScript([
      { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'rm -rf keep' }) }] },
      { content: 'Okay, I will not delete it.' },
    ]);
    settings.apiBase = mock.url;
    const runtime = makeRuntime();
    const c = conversation();
    const run = runtime.send(c, 'delete keep');
    await expect.poll(() => events.find((event) => event.type === 'approval')).toBeTruthy();
    const approval = events.find((event) => event.type === 'approval');
    if (approval?.type !== 'approval') throw new Error('no approval');
    expect(approval.request.title).toBe('rm -rf keep');
    runtime.approvals.decide(approval.request.id, 'deny');
    await run;

    expect(fs.existsSync(path.join(workDir, 'keep'))).toBe(true);
    expect(assistantSteps(c)[0].toolCalls[0].status).toBe('denied');
    expect(toolResults(mock.requests[1])[0]).toMatch(/denied/);
  });

  it('remembers "always allow" for the same command in the chat', async () => {
    await withScript([
      { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'someunknowntool-xyz one' }) }] },
      { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'someunknowntool-xyz two' }) }] },
      { content: 'finished' },
    ]);
    settings.apiBase = mock.url;
    const runtime = makeRuntime();
    const c = conversation();
    const run = runtime.send(c, 'go');
    await expect.poll(() => events.find((event) => event.type === 'approval')).toBeTruthy();
    const approval = events.find((event) => event.type === 'approval');
    if (approval?.type !== 'approval') throw new Error('no approval');
    runtime.approvals.decide(approval.request.id, 'always');
    await run;
    expect(events.filter((event) => event.type === 'approval')).toHaveLength(1);
    expect(assistantSteps(c).slice(0, 2).map((step) => step.toolCalls[0].status)).toEqual(['done', 'done']);
  });

  it('stops a running command when the user presses stop', async () => {
    await withScript([
      { tool_calls: [{ name: 'run_command', arguments: JSON.stringify({ command: process.platform === 'win32' ? 'Start-Sleep 30' : 'sleep 30' }) }] },
      { content: 'should not be reached' },
    ]);
    settings.apiBase = mock.url;
    settings.approvalPolicy = 'never';
    const runtime = makeRuntime();
    const c = conversation();
    const started = Date.now();
    const run = runtime.send(c, 'wait');
    await expect.poll(() => assistantSteps(c)[0]?.toolCalls[0]?.status).toBe('running');
    runtime.stop(c.id);
    await run;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(assistantSteps(c)[0].toolCalls[0].status).toBe('cancelled');
    expect(mock.requests).toHaveLength(1);
  });

  it('reports bad tool arguments to the model instead of crashing', async () => {
    await withScript([
      { tool_calls: [{ name: 'read_file', arguments: '{"path": ' }, { name: 'no_such_tool', arguments: '{}' }] },
      { content: 'recovered' },
    ]);
    settings.apiBase = mock.url;
    const c = conversation();
    await makeRuntime().send(c, 'x');
    const [bad, unknown] = assistantSteps(c)[0].toolCalls;
    expect(bad.status).toBe('error');
    expect(bad.result).toMatch(/Invalid JSON/);
    expect(unknown.result).toMatch(/Unknown tool/);
    expect(assistantSteps(c)[1].content).toBe('recovered');
  });

  it('keeps Chat mode away from file and command tools', async () => {
    await withScript([{ content: 'Hi!' }]);
    settings.apiBase = mock.url;
    await makeRuntime().send(conversation('chat'), 'hello');
    const names = mock.requests[0].tools?.map((tool) => tool.function.name) ?? [];
    expect(names).toContain('web_search');
    expect(names).not.toContain('run_command');
    expect(names).not.toContain('write_file');
    expect(mock.requests[0].messages[0].content).toMatch(/Chat mode/);
  });

  it('explains that the app is not connected yet', async () => {
    await withScript([{ content: 'unused' }]);
    const runtime = new Runtime({ settings: () => ({ ...settings, apiBase: mock.url }), apiKey: () => null, save: () => undefined, emit: () => undefined });
    const c = conversation();
    await runtime.send(c, 'hi');
    expect(assistantSteps(c)[0].error).toMatch(/Sign in or create/);
    expect(mock.requests).toHaveLength(0);
  });
});

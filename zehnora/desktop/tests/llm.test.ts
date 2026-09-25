import { afterEach, describe, expect, it } from 'vitest';
import type { MockModel } from './mock-model.mjs';
import { ThinkSplitter, complete } from '../src/main/llm';
import { startMockModel } from './mock-model.mjs';

let mock: MockModel | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

const noop = { onContent: () => undefined, onReasoning: () => undefined, onToolCalls: () => undefined };

describe('ThinkSplitter', () => {
  it('separates think tags across chunk boundaries', () => {
    const splitter = new ThinkSplitter();
    const parts = ['<thi', 'nk>plan it</th', 'ink>Answer', ' here'].map((text) => splitter.push(text));
    const flushed = splitter.flush();
    const content = parts.map((p) => p.content).join('') + flushed.content;
    const reasoning = parts.map((p) => p.reasoning).join('') + flushed.reasoning;
    expect(content).toBe('Answer here');
    expect(reasoning).toBe('plan it');
  });
});

describe('complete', () => {
  it('streams content, reasoning and assembles tool call deltas', async () => {
    mock = await startMockModel(() => ({ reasoning: 'thinking hard', content: 'Sure.', tool_calls: [{ name: 'run_command', arguments: '{"command":"ls -la","cwd":"."}' }] }));
    const seen: string[] = [];
    const result = await complete(
      { apiBase: mock.url, apiKey: mock.apiKey, model: 'zehnora-coder', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 100, signal: new AbortController().signal },
      { ...noop, onContent: (text) => seen.push(text) },
    );
    expect(result.content).toBe('Sure.');
    expect(seen.join('')).toBe('Sure.');
    expect(result.reasoning).toBe('thinking hard');
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: 'ls -la', cwd: '.' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
  });

  it('retries a server error that happened before any output', async () => {
    mock = await startMockModel((_body, count) => (count === 1 ? { status: 503, error: 'busy' } : { content: 'ok' }));
    const result = await complete({ apiBase: mock.url, apiKey: mock.apiKey, model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 10, signal: new AbortController().signal }, noop);
    expect(result.content).toBe('ok');
    expect(mock.requests).toHaveLength(2);
  });

  it('does not retry a rejected key', async () => {
    mock = await startMockModel();
    await expect(complete({ apiBase: mock.url, apiKey: 'sk-wrong-key-000000000', model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 10, signal: new AbortController().signal }, noop)).rejects.toMatchObject({ status: 401 });
  });
});

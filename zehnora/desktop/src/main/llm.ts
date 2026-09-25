import type { Usage } from '../shared/types';

export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchema };
}

export interface JsonSchema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface CompletionRequest {
  apiBase: string;
  apiKey: string;
  model: string;
  messages: ApiMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface StreamHandlers {
  onContent(text: string): void;
  onReasoning(text: string): void;
  onToolCalls(calls: ApiToolCall[]): void;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ApiToolCall[];
  finishReason: string | null;
  usage?: Usage;
}

interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
  error?: { message?: string };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Splits inline `<think>…</think>` blocks (models without a reasoning parser) from visible content, across chunk boundaries. */
export class ThinkSplitter {
  private buffer = '';
  private inThink = false;

  push(text: string): { content: string; reasoning: string } {
    this.buffer += text;
    let content = '';
    let reasoning = '';
    for (;;) {
      const tag = this.inThink ? THINK_CLOSE : THINK_OPEN;
      const at = this.buffer.indexOf(tag);
      if (at >= 0) {
        const before = this.buffer.slice(0, at);
        if (this.inThink) reasoning += before;
        else content += before;
        this.buffer = this.buffer.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const keep = partialTagLength(this.buffer, tag);
      const flushed = this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      if (this.inThink) reasoning += flushed;
      else content += flushed;
      return { content, reasoning };
    }
  }

  flush(): { content: string; reasoning: string } {
    const rest = this.buffer;
    this.buffer = '';
    return this.inThink ? { content: '', reasoning: rest } : { content: rest, reasoning: '' };
  }
}

function partialTagLength(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

async function errorFrom(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string; detail?: string };
    const detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.detail);
    if (detail) message = `${message}: ${detail}`;
  } catch {
    /* non-JSON error body */
  }
  const retryable = response.status === 429 || response.status >= 500;
  return new ApiError(message, response.status, retryable);
}

function mergeToolDeltas(calls: ApiToolCall[], deltas: NonNullable<StreamDelta['tool_calls']>): void {
  for (const delta of deltas) {
    const index = delta.index ?? calls.length;
    const call = (calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
    if (delta.id) call.id = delta.id;
    if (delta.function?.name) call.function.name += delta.function.name;
    if (delta.function?.arguments) call.function.arguments += delta.function.arguments;
  }
}

async function streamOnce(request: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
  const response = await fetch(`${request.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${request.apiKey}`, accept: 'text/event-stream' },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      tools: request.tools.length ? request.tools : undefined,
      tool_choice: request.tools.length ? 'auto' : undefined,
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: request.signal,
  });
  if (!response.ok || !response.body) throw await errorFrom(response);

  const result: CompletionResult = { content: '', reasoning: '', toolCalls: [], finishReason: null };
  const splitter = new ThinkSplitter();
  const emit = (part: { content: string; reasoning: string }): void => {
    if (part.content) {
      result.content += part.content;
      handlers.onContent(part.content);
    }
    if (part.reasoning) {
      result.reasoning += part.reasoning;
      handlers.onReasoning(part.reasoning);
    }
  };

  for await (const data of sseEvents(response.body)) {
    if (!data || data === '[DONE]') continue;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(data) as StreamChunk;
    } catch {
      continue;
    }
    if (chunk.error) throw new ApiError(chunk.error.message ?? 'The model stream reported an error', 502, false);
    if (chunk.usage) result.usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) emit({ content: '', reasoning });
    if (delta.content) emit(splitter.push(delta.content));
    if (delta.tool_calls?.length) {
      mergeToolDeltas(result.toolCalls, delta.tool_calls);
      handlers.onToolCalls(result.toolCalls);
    }
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
  }
  emit(splitter.flush());
  result.toolCalls = result.toolCalls.filter((call) => call.function.name);
  result.toolCalls.forEach((call, index) => {
    call.id ||= `call_${Date.now().toString(36)}_${index}`;
  });
  return result;
}

const RETRY_DELAYS_MS = [1500, 5000];

/** Streams one completion; retries only failures that happen before any output reached the caller. */
export async function complete(request: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
  for (let attempt = 0; ; attempt++) {
    let produced = false;
    const tracked: StreamHandlers = {
      onContent: (text) => ((produced = true), handlers.onContent(text)),
      onReasoning: (text) => ((produced = true), handlers.onReasoning(text)),
      onToolCalls: (calls) => ((produced = true), handlers.onToolCalls(calls)),
    };
    try {
      return await streamOnce(request, tracked);
    } catch (error) {
      const retryable = error instanceof ApiError ? error.retryable : !request.signal.aborted && error instanceof TypeError;
      if (produced || !retryable || attempt >= RETRY_DELAYS_MS.length || request.signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function checkModel(apiBase: string, apiKey: string): Promise<{ status: number; models: string[] }> {
  try {
    const response = await fetch(`${apiBase}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return { status: response.status, models: [] };
    const body = (await response.json()) as { data?: { id: string }[] };
    return { status: 200, models: (body.data ?? []).map((model) => model.id) };
  } catch {
    return { status: 0, models: [] };
  }
}

import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { AgentEvent, AssistantMessage, Conversation, Settings, ToolCall, UserMessage } from '../../shared/types';
import type { ApiToolCall } from '../llm';
import type { Args, Tool, ToolContext } from '../tools/types';
import { Approvals, needsApproval } from './approvals';
import { toolsFor, schemasFor } from '../tools';
import { ToolError } from '../tools/types';
import { buildMessages } from './context';
import { systemPrompt } from './prompts';
import { ApiError, complete } from '../llm';

const MAX_STEPS = { chat: 8, work: 60 } as const;
const EMIT_INTERVAL_MS = 60;
const MAX_IDENTICAL_FAILURES = 2;

export interface RuntimeDeps {
  settings(): Settings;
  apiKey(): string | null;
  save(conversation: Conversation): void;
  emit(event: AgentEvent): void;
}

const newId = (): string => crypto.randomUUID();

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

function parseArgs(raw: string): Args {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as Args | string;
  if (typeof parsed === 'string') return JSON.parse(parsed) as Args;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ToolError('Tool arguments must be a JSON object.');
  return parsed;
}

function describeError(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'The Zehnora API rejected the key (401). Check the API key in Settings.';
    if (error.status === 402) return 'Your account is out of credits (402). Ask the Zehnora admin to add credits.';
    if (error.status === 429) return 'The model server is busy (429). Try again in a moment.';
    if (error.status === 530 || error.status === 502 || error.status === 503) return 'The Zehnora server is offline right now. Try again later.';
    return `Model API error: ${error.message}`;
  }
  if (error.name === 'AbortError') return 'Stopped.';
  if (error instanceof TypeError) return `Could not reach the model API (${error.message}). Check your internet connection and the API address in Settings.`;
  return error.message;
}

export class Runtime {
  readonly approvals: Approvals;
  private readonly runs = new Map<string, AbortController>();
  private readonly lastEmit = new Map<string, number>();
  private readonly pendingEmit = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: RuntimeDeps) {
    this.approvals = new Approvals(deps.emit);
  }

  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  stop(conversationId: string): void {
    this.runs.get(conversationId)?.abort();
  }

  stopAll(): void {
    for (const controller of this.runs.values()) controller.abort();
  }

  workDir(conversation: Conversation): string {
    if (conversation.mode === 'chat') return os.homedir();
    const dir = conversation.cwd ?? this.deps.settings().defaultWorkDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private emitMessage(conversation: Conversation, message: AssistantMessage | UserMessage, force = false): void {
    const key = message.id;
    const flush = (): void => {
      this.pendingEmit.delete(key);
      this.lastEmit.set(key, Date.now());
      this.deps.emit({ type: 'message', conversationId: conversation.id, message: structuredClone(message) });
    };
    const timer = this.pendingEmit.get(key);
    if (force) {
      if (timer) clearTimeout(timer);
      flush();
      return;
    }
    if (timer) return;
    const wait = EMIT_INTERVAL_MS - (Date.now() - (this.lastEmit.get(key) ?? 0));
    if (wait <= 0) flush();
    else this.pendingEmit.set(key, setTimeout(flush, wait));
  }

  async send(conversation: Conversation, text: string): Promise<void> {
    if (this.runs.has(conversation.id)) throw new Error('This chat is still working. Stop it or wait for it to finish.');
    const user: UserMessage = { id: newId(), role: 'user', content: text, createdAt: Date.now() };
    conversation.messages.push(user);
    if (conversation.title === 'New chat') conversation.title = titleFrom(text);
    this.deps.save(conversation);
    this.emitMessage(conversation, user, true);
    this.deps.emit({ type: 'conversation', summary: { id: conversation.id, mode: conversation.mode, title: conversation.title, cwd: conversation.cwd, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt } });

    const controller = new AbortController();
    this.runs.set(conversation.id, controller);
    this.deps.emit({ type: 'run-state', conversationId: conversation.id, running: true });
    try {
      await this.loop(conversation, controller.signal);
    } finally {
      this.runs.delete(conversation.id);
      this.deps.save(conversation);
      this.deps.emit({ type: 'run-state', conversationId: conversation.id, running: false });
    }
  }

  private async loop(conversation: Conversation, signal: AbortSignal): Promise<void> {
    const tools = toolsFor(conversation.mode);
    const schemas = schemasFor(conversation.mode);
    const failures = new Map<string, number>();
    const maxSteps = MAX_STEPS[conversation.mode];

    for (let step = 0; step < maxSteps; step++) {
      const settings = this.deps.settings();
      const apiKey = this.deps.apiKey();
      const message: AssistantMessage = { id: newId(), role: 'assistant', content: '', reasoning: '', toolCalls: [], createdAt: Date.now(), streaming: true };
      conversation.messages.push(message);
      this.emitMessage(conversation, message, true);
      if (!apiKey) {
        this.finishWithError(conversation, message, 'Not connected yet. Sign in or create a Zehnora account to start.');
        return;
      }

      const cwd = this.workDir(conversation);
      const request = buildMessages(systemPrompt(conversation.mode, cwd), conversation.messages.slice(0, -1), schemas, settings.contextTokens, settings.maxOutputTokens);
      let result;
      try {
        result = await complete(
          { apiBase: settings.apiBase, apiKey, model: settings.model, messages: request, tools: schemas, maxTokens: settings.maxOutputTokens, signal },
          {
            onContent: (chunk) => {
              message.content += chunk;
              this.emitMessage(conversation, message);
            },
            onReasoning: (chunk) => {
              message.reasoning += chunk;
              this.emitMessage(conversation, message);
            },
            onToolCalls: (calls) => {
              message.toolCalls = calls.map((call) => this.draftCall(call));
              this.emitMessage(conversation, message);
            },
          },
        );
      } catch (error) {
        this.finishWithError(conversation, message, signal.aborted ? 'Stopped.' : describeError(error as Error));
        return;
      }

      message.content = result.content.trim();
      message.reasoning = result.reasoning.trim();
      message.usage = result.usage;
      message.toolCalls = result.toolCalls.map((call) => this.draftCall(call));
      message.streaming = false;
      if (result.finishReason === 'length' && !message.toolCalls.length) message.error = 'The reply hit the output limit and was cut off. Ask to continue.';
      this.emitMessage(conversation, message, true);
      this.deps.save(conversation);

      if (!message.toolCalls.length) return;
      for (const call of message.toolCalls) {
        if (signal.aborted) {
          call.status = 'cancelled';
          continue;
        }
        await this.execute(conversation, message, call, tools, failures, { conversationId: conversation.id, mode: conversation.mode, cwd, signal });
      }
      this.emitMessage(conversation, message, true);
      this.deps.save(conversation);
      if (signal.aborted) return;
    }

    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === 'assistant') {
      last.error = `Paused after ${maxSteps} steps. Send "continue" to keep going.`;
      this.emitMessage(conversation, last, true);
    }
  }

  private draftCall(call: ApiToolCall): ToolCall {
    return { id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'pending' };
  }

  private finishWithError(conversation: Conversation, message: AssistantMessage, error: string): void {
    message.streaming = false;
    message.error = error;
    for (const call of message.toolCalls) if (call.status === 'pending') call.status = 'cancelled';
    this.emitMessage(conversation, message, true);
  }

  private async execute(conversation: Conversation, message: AssistantMessage, call: ToolCall, tools: Map<string, Tool>, failures: Map<string, number>, context: ToolContext): Promise<void> {
    const fail = (text: string, status: ToolCall['status'] = 'error'): void => {
      call.status = status;
      call.result = text;
      call.endedAt = Date.now();
      this.emitMessage(conversation, message, true);
    };
    const tool = tools.get(call.name);
    if (!tool) return fail(`Unknown tool "${call.name}". Available: ${[...tools.keys()].join(', ')}.`);
    let args: Args;
    try {
      args = parseArgs(call.arguments);
    } catch (error) {
      return fail(`Invalid JSON arguments (${(error as Error).message}). Send a valid JSON object.`);
    }
    const signature = `${call.name}:${JSON.stringify(args)}`;
    if ((failures.get(signature) ?? 0) >= MAX_IDENTICAL_FAILURES) return fail('This exact call already failed twice. Change the arguments or take a different approach.');

    let assessment;
    try {
      assessment = tool.assess(args, context);
    } catch (error) {
      return fail((error as Error).message);
    }
    call.risk = assessment.risk;
    call.summary = assessment.title;
    const policy = this.deps.settings().approvalPolicy;
    if (needsApproval(assessment.risk, policy) && !this.approvals.isAllowed(conversation.id, assessment.allowKey)) {
      call.status = 'awaiting-approval';
      this.emitMessage(conversation, message, true);
      const decision = await this.approvals.request(
        { conversationId: conversation.id, toolCallId: call.id, tool: call.name, title: assessment.title, detail: assessment.detail, cwd: context.cwd, reason: assessment.risk },
        assessment.allowKey,
        context.signal,
      );
      if (context.signal.aborted) return fail('Cancelled by the user.', 'cancelled');
      if (decision === 'deny') return fail('The user denied this action.', 'denied');
    }

    call.status = 'running';
    call.startedAt = Date.now();
    this.emitMessage(conversation, message, true);
    try {
      call.result = await tool.run(args, context);
      call.status = context.signal.aborted ? 'cancelled' : 'done';
      call.endedAt = Date.now();
      this.emitMessage(conversation, message, true);
    } catch (error) {
      failures.set(signature, (failures.get(signature) ?? 0) + 1);
      const text = error instanceof ToolError ? error.message : `${(error as Error).name}: ${(error as Error).message}`;
      fail(context.signal.aborted ? 'Cancelled by the user.' : text, context.signal.aborted ? 'cancelled' : 'error');
    }
  }
}

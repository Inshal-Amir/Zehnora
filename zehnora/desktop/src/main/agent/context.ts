import type { ApiMessage, ToolSchema } from '../llm';
import type { Message, ToolCall } from '../../shared/types';

const CHARS_PER_TOKEN = 3.2;
const RECENT_TOOL_RESULTS = 8;
const SHRUNK_RESULT_CHARS = 700;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

function toolResultText(call: ToolCall): string {
  if (call.status === 'denied') return 'The user denied this action. Do not retry it; choose another approach or explain what is needed.';
  if (call.status === 'cancelled') return 'Cancelled by the user.';
  if (call.status === 'error') return `Error: ${call.result ?? 'unknown error'}`;
  return call.result ?? '(no result)';
}

/** One user turn, or one assistant step with its tool results; groups are dropped whole so tool results stay paired. */
type Group = ApiMessage[];

function toGroups(messages: Message[]): Group[] {
  const groups: Group[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      groups.push([{ role: 'user', content: message.content }]);
      continue;
    }
    const calls = message.toolCalls.filter((call) => call.status !== 'pending');
    if (!message.content && !calls.length) continue;
    const group: Group = [
      {
        role: 'assistant',
        content: message.content || null,
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments || '{}' } })) } : {}),
      },
    ];
    for (const call of calls) group.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(call) });
    groups.push(group);
  }
  return groups;
}

const sizeOf = (message: ApiMessage): number => {
  if (message.role === 'assistant') return estimateTokens((message.content ?? '') + JSON.stringify(message.tool_calls ?? '')) + 4;
  return estimateTokens(message.content) + 4;
};

function shrinkOldToolResults(groups: Group[]): void {
  let seen = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    for (let m = groups[g].length - 1; m >= 0; m--) {
      const message = groups[g][m];
      if (message.role !== 'tool') continue;
      seen++;
      if (seen <= RECENT_TOOL_RESULTS || message.content.length <= SHRUNK_RESULT_CHARS) continue;
      groups[g][m] = { ...message, content: `${message.content.slice(0, SHRUNK_RESULT_CHARS)}\n… [older tool output shortened to save context; run the tool again if you need it]` };
    }
  }
}

/**
 * Builds the request messages within the context budget: first older tool outputs are shortened,
 * then the oldest turns are dropped (the first user message is kept for the task statement).
 */
export function buildMessages(system: string, messages: Message[], tools: ToolSchema[], contextTokens: number, maxOutputTokens: number): ApiMessage[] {
  const budget = contextTokens - maxOutputTokens - estimateTokens(system) - estimateTokens(JSON.stringify(tools));
  const groups = toGroups(messages);
  const total = (): number => groups.reduce((sum, group) => sum + group.reduce((s, m) => s + sizeOf(m), 0), 0);
  if (total() > budget) shrinkOldToolResults(groups);
  let dropped = 0;
  while (groups.length > 2 && total() > budget) {
    groups.splice(1, 1);
    dropped++;
  }
  while (groups.length > 1 && groups[1][0].role === 'tool') groups.splice(1, 1);
  const notice: ApiMessage[] = dropped ? [{ role: 'user', content: `[${dropped} earlier step(s) of this conversation were removed to fit the context window. Re-read files if you need details.]` }] : [];
  const [first, ...rest] = groups;
  return [{ role: 'system', content: system }, ...(first ?? []), ...notice, ...rest.flat()];
}

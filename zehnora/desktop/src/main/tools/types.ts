import type { JsonSchema } from '../llm';
import type { Mode, Risk } from '../../shared/types';

export type ArgValue = string | number | boolean | null | ArgValue[] | { [key: string]: ArgValue };
export type Args = { [key: string]: ArgValue };

export interface ToolContext {
  conversationId: string;
  mode: Mode;
  cwd: string;
  signal: AbortSignal;
}

export interface Assessment {
  risk: Risk;
  title: string;
  detail: string;
  /** Key used by "allow for this chat": same key, no second prompt. */
  allowKey: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  modes: Mode[];
  assess(args: Args, context: ToolContext): Assessment;
  run(args: Args, context: ToolContext): Promise<string>;
}

export class ToolError extends Error {}

export function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value === 'string' && value.length) return value;
  if (typeof value === 'number') return String(value);
  throw new ToolError(`Missing required string argument "${key}".`);
}

export function optStr(args: Args, key: string, fallback = ''): string {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new ToolError(`Argument "${key}" must be a string.`);
}

export function optInt(args: Args, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new ToolError(`Argument "${key}" must be a number.`);
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function optBool(args: Args, key: string, fallback = false): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true';
}

const HEAD_CHARS = 3000;

/** Keeps the start and the end of long output, which is where errors and summaries usually are. */
export function clip(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  const tail = max - HEAD_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(-tail)}`;
}

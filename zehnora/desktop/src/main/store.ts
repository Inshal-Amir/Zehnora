import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { Conversation, ConversationSummary, Mode } from '../shared/types';

const dir = (): string => path.join(app.getPath('userData'), 'conversations');
const fileOf = (id: string): string => path.join(dir(), `${id}.json`);
const ID_PATTERN = /^[a-f0-9-]{36}$/;

const conversations = new Map<string, Conversation>();
let loaded = false;

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadAll(): void {
  if (loaded) return;
  loaded = true;
  fs.mkdirSync(dir(), { recursive: true });
  for (const name of fs.readdirSync(dir())) {
    if (!name.endsWith('.json')) continue;
    try {
      const conversation = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8')) as Conversation;
      conversations.set(conversation.id, conversation);
    } catch {
      /* a corrupt file must not stop the app from starting */
    }
  }
}

export const summarize = ({ messages: _messages, ...summary }: Conversation): ConversationSummary => summary;

export function list(): ConversationSummary[] {
  loadAll();
  return [...conversations.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function get(id: string): Conversation | null {
  loadAll();
  return conversations.get(id) ?? null;
}

export function create(mode: Mode, cwd?: string): Conversation {
  loadAll();
  const now = Date.now();
  const conversation: Conversation = { id: crypto.randomUUID(), mode, title: 'New chat', cwd, createdAt: now, updatedAt: now, messages: [] };
  conversations.set(conversation.id, conversation);
  return conversation;
}

export function save(conversation: Conversation): void {
  if (!ID_PATTERN.test(conversation.id)) return;
  conversation.updatedAt = Date.now();
  fs.mkdirSync(dir(), { recursive: true });
  writeAtomic(fileOf(conversation.id), JSON.stringify(conversation));
}

export function remove(id: string): void {
  loadAll();
  conversations.delete(id);
  if (ID_PATTERN.test(id)) fs.rmSync(fileOf(id), { force: true });
}

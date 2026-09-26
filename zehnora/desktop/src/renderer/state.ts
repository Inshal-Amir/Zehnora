import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AccountStatus, ApprovalRequest, Conversation, ConversationSummary, Message, Mode, ModelStatus, ProcessInfo, Settings, ZehnoraApi } from '../shared/types';

declare global {
  interface Window {
    zehnora: ZehnoraApi;
  }
}

export const api = (): ZehnoraApi => window.zehnora;

const LAST_MODE_KEY = 'zehnora.mode';

function readMode(): Mode {
  try {
    return localStorage.getItem(LAST_MODE_KEY) === 'work' ? 'work' : 'chat';
  } catch {
    return 'chat';
  }
}

function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((existing) => existing.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

function upsertSummary(list: ConversationSummary[], summary: ConversationSummary): ConversationSummary[] {
  const rest = list.filter((entry) => entry.id !== summary.id);
  return [summary, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface AppState {
  mode: Mode;
  conversations: ConversationSummary[];
  active: Conversation | null;
  running: Set<string>;
  approvals: ApprovalRequest[];
  processes: ProcessInfo[];
  settings: Settings | null;
  status: ModelStatus | null;
  account: AccountStatus | null;
  signOut(): Promise<void>;
  setMode(mode: Mode): void;
  open(id: string): Promise<void>;
  newChat(mode?: Mode): Promise<void>;
  send(text: string): Promise<void>;
  stop(): void;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  changeWorkDir(): Promise<void>;
  saveSettings(settings: Parameters<ZehnoraApi['saveSettings']>[0]): Promise<void>;
  refreshStatus(): Promise<void>;
}

export function useAppState(): AppState {
  const [mode, setModeState] = useState<Mode>(readMode);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [account, setAccount] = useState<AccountStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    const [model, who, current] = await Promise.all([api().modelStatus(), api().accountStatus(), api().getSettings()]);
    setStatus(model);
    setAccount(who);
    setSettings(current);
  }, []);

  useEffect(() => {
    api().listConversations().then(setConversations);
    api().getSettings().then(setSettings);
    api().listProcesses().then(setProcesses);
    refreshStatus();
    const timer = setInterval(refreshStatus, 60_000);
    const off = api().onEvent((event) => {
      if (event.type === 'message') {
        setActive((current) => (current && current.id === event.conversationId ? { ...current, messages: upsertMessage(current.messages, event.message) } : current));
      } else if (event.type === 'conversation') {
        setConversations((list) => upsertSummary(list, event.summary));
        setActive((current) => (current && current.id === event.summary.id ? { ...current, ...event.summary } : current));
      } else if (event.type === 'run-state') {
        setRunning((set) => {
          const next = new Set(set);
          if (event.running) next.add(event.conversationId);
          else next.delete(event.conversationId);
          return next;
        });
      } else if (event.type === 'approval') {
        setApprovals((list) => [...list, event.request]);
      } else if (event.type === 'approval-resolved') {
        setApprovals((list) => list.filter((request) => request.id !== event.id));
      } else if (event.type === 'processes') {
        setProcesses(event.processes);
      }
    });
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refreshStatus]);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    try {
      localStorage.setItem(LAST_MODE_KEY, next);
    } catch {
      /* storage can be unavailable */
    }
    setActive((current) => (current && current.mode !== next ? null : current));
  }, []);

  const open = useCallback(async (id: string) => {
    const conversation = await api().getConversation(id);
    if (!conversation) return;
    setActive(conversation);
    setModeState(conversation.mode);
  }, []);

  const newChat = useCallback(async (target?: Mode) => {
    const conversation = await api().createConversation(target ?? mode);
    setActive(conversation);
  }, [mode]);

  const send = useCallback(async (text: string) => {
    let conversation = active;
    if (!conversation) {
      conversation = await api().createConversation(mode);
      setActive(conversation);
    }
    await api().send(conversation.id, text);
  }, [active, mode]);

  const stop = useCallback(() => {
    if (active) api().stop(active.id);
  }, [active]);

  const remove = useCallback(async (id: string) => {
    await api().deleteConversation(id);
    setConversations((list) => list.filter((entry) => entry.id !== id));
    setActive((current) => (current?.id === id ? null : current));
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    await api().renameConversation(id, title);
  }, []);

  const changeWorkDir = useCallback(async () => {
    if (!active) return;
    const dir = await api().setWorkDir(active.id);
    if (dir) setActive((current) => (current ? { ...current, cwd: dir } : current));
  }, [active]);

  const saveSettings = useCallback(async (patch: Parameters<ZehnoraApi['saveSettings']>[0]) => {
    setSettings(await api().saveSettings(patch));
    await refreshStatus();
  }, [refreshStatus]);

  const signOut = useCallback(async () => {
    await api().signOut();
    await refreshStatus();
  }, [refreshStatus]);

  const visible = useMemo(() => conversations.filter((entry) => entry.mode === mode && entry.title !== 'New chat'), [conversations, mode]);

  return { mode, conversations: visible, active, running, approvals, processes, settings, status, account, signOut, setMode, open, newChat, send, stop, remove, rename, changeWorkDir, saveSettings, refreshStatus };
}

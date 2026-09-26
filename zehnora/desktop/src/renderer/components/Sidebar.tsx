import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { ConversationSummary, Mode, ModelStatus } from '../../shared/types';
import { Icon } from './Icon';

const DAY = 86_400_000;

function groupByAge(list: ConversationSummary[]): [string, ConversationSummary[]][] {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups = new Map<string, ConversationSummary[]>();
  for (const entry of list) {
    const label = entry.updatedAt >= startOfToday ? 'Today' : entry.updatedAt >= startOfToday - DAY ? 'Yesterday' : entry.updatedAt >= startOfToday - 7 * DAY ? 'Previous 7 days' : 'Older';
    const bucket = groups.get(label) ?? [];
    bucket.push(entry);
    groups.set(label, bucket);
  }
  return [...groups.entries()];
}

const STATUS_TEXT: Record<ModelStatus['state'], string> = { online: 'Model online', offline: 'Model offline', unauthorized: 'Key rejected', 'no-key': 'Not signed in' };

function Row({ entry, active, running, onOpen, onDelete, onRename }: {
  entry: ConversationSummary;
  active: boolean;
  running: boolean;
  onOpen(): void;
  onDelete(): void;
  onRename(title: string): void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  if (editing) {
    return (
      <input
        className="row-edit"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() && draft !== entry.title) onRename(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') setEditing(false);
        }}
        aria-label="Rename chat"
      />
    );
  }
  return (
    <div className={`row ${active ? 'active' : ''}`}>
      <button type="button" className="row-main" onClick={onOpen} onDoubleClick={() => setEditing(true)} title={entry.title}>
        {running && <span className="dot live" aria-label="Working" />}
        <span className="row-title">{entry.title}</span>
      </button>
      <button type="button" className="row-delete" onClick={onDelete} aria-label="Delete chat">
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

export function Sidebar({ mode, conversations, activeId, running, status, onMode, onNew, onOpen, onDelete, onRename, onSettings }: {
  mode: Mode;
  conversations: ConversationSummary[];
  activeId: string | null;
  running: Set<string>;
  status: ModelStatus | null;
  onMode(mode: Mode): void;
  onNew(): void;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onRename(id: string, title: string): void;
  onSettings(): void;
}): ReactElement {
  const groups = useMemo(() => groupByAge(conversations), [conversations]);
  return (
    <aside className="sidebar" aria-label="Conversations">
      <div className="sidebar-top drag">
        <div className="brand">
          <span className="brand-mark">Z</span>
          <span>Zehnora</span>
        </div>
      </div>
      <div className="mode-switch" role="tablist" aria-label="Mode">
        {(['chat', 'work'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={mode === value} className={mode === value ? 'on' : ''} onClick={() => onMode(value)}>
            <Icon name={value} size={15} />
            {value === 'chat' ? 'Chat' : 'Work'}
          </button>
        ))}
      </div>
      <button type="button" className="new-chat" onClick={onNew}>
        <Icon name="plus" size={16} />
        {mode === 'chat' ? 'New chat' : 'New task'}
      </button>
      <nav className="history">
        {!groups.length && <div className="history-empty">{mode === 'chat' ? 'Your chats will appear here.' : 'Your tasks will appear here.'}</div>}
        {groups.map(([label, entries]) => (
          <div key={label} className="history-group">
            <div className="history-label">{label}</div>
            {entries.map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                active={entry.id === activeId}
                running={running.has(entry.id)}
                onOpen={() => onOpen(entry.id)}
                onDelete={() => onDelete(entry.id)}
                onRename={(title) => onRename(entry.id, title)}
              />
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button type="button" className="status" onClick={onSettings} title={status?.detail}>
          <span className={`dot ${status?.state ?? 'offline'}`} />
          <span>{status ? STATUS_TEXT[status.state] : 'Checking…'}</span>
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label="Settings">
          <Icon name="settings" size={18} />
        </button>
      </div>
    </aside>
  );
}

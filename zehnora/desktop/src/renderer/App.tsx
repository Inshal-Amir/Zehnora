import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import type { ProcessInfo } from '../shared/types';
import { Composer } from './components/Composer';
import { Settings } from './components/Settings';
import { Sidebar } from './components/Sidebar';
import { Welcome } from './components/Welcome';
import { Thread } from './components/Thread';
import { Icon } from './components/Icon';
import { api, useAppState } from './state';

function ProcessMenu({ processes }: { processes: ProcessInfo[] }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const live = processes.filter((entry) => entry.running);
  if (!processes.length) return null;
  return (
    <div className="proc">
      <button type="button" className="chip" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="terminal" size={14} />
        {live.length} running
      </button>
      {open && (
        <div className="proc-menu">
          {processes.map((entry) => (
            <div key={entry.id} className="proc-row">
              <span className={`dot ${entry.running ? 'online' : 'offline'}`} />
              <div className="proc-text">
                <div>{entry.name}</div>
                <code>{entry.command}</code>
              </div>
              {entry.running && (
                <button type="button" className="btn small" onClick={() => api().stopProcess(entry.id)}>Stop</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function App(): ReactElement {
  const state = useAppState();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const { active, mode } = state;
  const running = active ? state.running.has(active.id) : false;
  const hasMessages = Boolean(active?.messages.length);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const workDir = active?.cwd ?? state.settings?.defaultWorkDir;

  return (
    <div className={`app mac-${api().platform === 'darwin'}`}>
      <Sidebar
        mode={mode}
        conversations={state.conversations}
        activeId={active?.id ?? null}
        running={state.running}
        status={state.status}
        onMode={state.setMode}
        onNew={() => state.newChat()}
        onOpen={state.open}
        onDelete={state.remove}
        onRename={state.rename}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <header className="topbar drag">
          <div className="topbar-title">{hasMessages ? active?.title : mode === 'chat' ? 'Chat' : 'Work'}</div>
          <div className="topbar-actions no-drag">
            {mode === 'work' && <ProcessMenu processes={state.processes} />}
            {mode === 'work' && workDir && (
              <button type="button" className="chip" onClick={active ? state.changeWorkDir : () => setSettingsOpen(true)} title={`Working folder: ${workDir}`}>
                <Icon name="folder" size={14} />
                <span className="chip-path">{workDir.replace(/^\/Users\/[^/]+|^C:\\Users\\[^\\]+/, '~')}</span>
              </button>
            )}
          </div>
        </header>
        {state.status?.state === 'no-key' && (
          <div className="banner">
            Add your Zehnora API key to start.
            <button type="button" className="btn small primary" onClick={() => setSettingsOpen(true)}>Open settings</button>
          </div>
        )}
        {hasMessages && active ? <Thread messages={active.messages} approvals={state.approvals} /> : <Welcome mode={mode} onPick={(text) => setSeed({ text, nonce: Date.now() })} />}
        <Composer mode={mode} running={running} disabled={false} onSend={state.send} onStop={state.stop} seed={seed} />
      </main>
      {settingsOpen && state.settings && <Settings settings={state.settings} status={state.status} onSave={state.saveSettings} onClose={closeSettings} />}
    </div>
  );
}

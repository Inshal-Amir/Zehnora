import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { ApprovalPolicy, ModelStatus, Settings as SettingsType, SettingsPatch } from '../../shared/types';
import { Icon } from './Icon';
import { api } from '../state';

const POLICIES: { value: ApprovalPolicy; title: string; text: string }[] = [
  { value: 'risky', title: 'Ask for risky actions', text: 'Recommended. Deleting, pushing, sudo, system installs, unknown programs and changes outside the working folder ask first.' },
  { value: 'writes', title: 'Ask before any change', text: 'Only reading and searching run on their own. Every file change and command that changes something asks first.' },
  { value: 'never', title: 'Never ask', text: 'Zehnora acts without asking. Only use this if you trust the task completely.' },
];

export function Settings({ settings, status, onSave, onClose }: {
  settings: SettingsType;
  status: ModelStatus | null;
  onSave(patch: SettingsPatch): Promise<void>;
  onClose(): void;
}): ReactElement {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof SettingsType>(key: K, value: SettingsType[K]): void => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { hasApiKey: _key, hasGithubToken: _token, ...rest } = draft;
      await onSave({ ...rest, ...(apiKey ? { apiKey } : {}), ...(githubToken ? { githubToken } : {}) });
      setApiKey('');
      setGithubToken('');
      onClose();
    } catch (failure) {
      setError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async (): Promise<void> => {
    const dir = await api().chooseDirectory(draft.defaultWorkDir);
    if (dir) set('defaultWorkDir', dir);
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} role="dialog" aria-label="Settings">
        <div className="dialog-head">
          <h2>Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="dialog-body">
          <section>
            <h3>Model</h3>
            <label>
              API key
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.hasApiKey ? 'Saved (paste a new key to replace it)' : 'sk-…'} autoComplete="off" />
            </label>
            <div className="field-note">
              {status && <span className={`dot ${status.state}`} />} {status?.detail ?? ''}. Create keys at{' '}
              <a href="https://console.dubg.dev" onClick={(event) => { event.preventDefault(); api().openExternal('https://console.dubg.dev'); }}>console.dubg.dev</a>.
            </div>
            <div className="grid2">
              <label>
                API address
                <input value={draft.apiBase} onChange={(event) => set('apiBase', event.target.value)} spellCheck={false} />
              </label>
              <label>
                Model
                <input value={draft.model} onChange={(event) => set('model', event.target.value)} spellCheck={false} />
              </label>
              <label>
                Context window (tokens)
                <input type="number" value={draft.contextTokens} onChange={(event) => set('contextTokens', Number(event.target.value))} />
              </label>
              <label>
                Max reply tokens
                <input type="number" value={draft.maxOutputTokens} onChange={(event) => set('maxOutputTokens', Number(event.target.value))} />
              </label>
            </div>
          </section>
          <section>
            <h3>Work mode</h3>
            <label>
              Default working folder
              <div className="input-row">
                <input value={draft.defaultWorkDir} onChange={(event) => set('defaultWorkDir', event.target.value)} spellCheck={false} />
                <button type="button" className="btn" onClick={pickFolder}>Choose…</button>
              </div>
            </label>
            <div className="policy">
              {POLICIES.map((policy) => (
                <label key={policy.value} className={`policy-option ${draft.approvalPolicy === policy.value ? 'on' : ''}`}>
                  <input type="radio" name="policy" checked={draft.approvalPolicy === policy.value} onChange={() => set('approvalPolicy', policy.value)} />
                  <span className="policy-title">{policy.title}</span>
                  <span className="policy-text">{policy.text}</span>
                </label>
              ))}
            </div>
          </section>
          <section>
            <h3>Web and GitHub</h3>
            <div className="grid2">
              <label>
                GitHub token (optional)
                <input type="password" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} placeholder={settings.hasGithubToken ? 'Saved' : 'ghp_… for higher limits and gh CLI'} autoComplete="off" />
              </label>
              <label>
                SearXNG address (optional)
                <input value={draft.searxngUrl} onChange={(event) => set('searxngUrl', event.target.value)} placeholder="http://127.0.0.1:8888" spellCheck={false} />
              </label>
            </div>
          </section>
          <section>
            <h3>Appearance</h3>
            <div className="segmented">
              {(['system', 'light', 'dark'] as const).map((theme) => (
                <button key={theme} type="button" className={draft.theme === theme ? 'on' : ''} onClick={() => set('theme', theme)}>
                  {theme[0].toUpperCase() + theme.slice(1)}
                </button>
              ))}
            </div>
          </section>
          {error && <div className="step-error" role="alert">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { ModelStatus } from '../../shared/types';
import { api } from '../state';

const cleanError = (error: Error): string => error.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

export function Onboarding({ status, onConnected, onUseKey }: { status: ModelStatus | null; onConnected(): void; onUseKey(): void }): ReactElement {
  const [create, setCreate] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (create && password.length < 10) {
      setError('Use at least 10 characters for the password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api().connectAccount(email, password, create);
      onConnected();
    } catch (failure) {
      setError(cleanError(failure as Error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="welcome">
      <div className="welcome-mark">Z</div>
      <h1>Welcome to Zehnora</h1>
      <p>{create ? 'Create a free account to start chatting and working with Zehnora.' : 'Sign in with your Zehnora account.'}</p>
      <form className="onboard" onSubmit={submit} aria-label={create ? 'Create account' : 'Sign in'}>
        <div className="segmented wide" role="tablist">
          <button type="button" role="tab" aria-selected={create} className={create ? 'on' : ''} onClick={() => setCreate(true)}>Create account</button>
          <button type="button" role="tab" aria-selected={!create} className={!create ? 'on' : ''} onClick={() => setCreate(false)}>Sign in</button>
        </div>
        <label>
          Email
          <input type="email" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
        </label>
        <label>
          Password
          <input type="password" required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={create ? 'new-password' : 'current-password'} placeholder={create ? 'At least 10 characters' : ''} />
        </label>
        {error && <div className="step-error" role="alert">{error}</div>}
        <button type="submit" className="btn primary big" disabled={busy}>{busy ? 'Connecting…' : create ? 'Create account' : 'Sign in'}</button>
        <button type="button" className="link" onClick={onUseKey}>I already have an API key</button>
        {status?.state === 'offline' && <div className="field-note">Note: {status.detail}.</div>}
      </form>
    </div>
  );
}

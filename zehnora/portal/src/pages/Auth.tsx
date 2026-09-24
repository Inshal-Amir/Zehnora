import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import brand from '@brand/brand.json';
import { api } from '../api';
import { ErrorNote, useSession } from '../App';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(mode === 'login' ? '/auth/login' : '/auth/register', { email, password });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <span className="mark">{brand.productName[0]}</span>
        <h1>{mode === 'login' ? `Welcome back` : `Create your account`}</h1>
        <p className="muted">{mode === 'login' ? `Sign in to ${brand.productName} Platform` : `Start building with ${brand.productName}`}</p>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password
          <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 10 : undefined}
                 value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {mode === 'register' && <p className="muted small">At least 10 characters. New accounts start with zero credits. {brand.creditsNotice}</p>}
        <ErrorNote error={error} />
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="small">
          {mode === 'login' ? <>No account? <Link to="/register">Create one</Link></> : <>Have an account? <Link to="/">Sign in</Link></>}
        </p>
        {mode === 'login' && <p className="muted small">Password reset needs email delivery, which is not configured on this deployment yet. Ask the administrator.</p>}
      </form>
    </div>
  );
}

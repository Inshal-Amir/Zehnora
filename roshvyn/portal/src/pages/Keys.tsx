import { useEffect, useState, type FormEvent } from 'react';
import { api, when, type KeyView } from '../api';
import { ErrorNote } from '../App';

export default function Keys() {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try { setKeys((await api.get<{ keys: KeyView[] }>('/keys')).keys); } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post<{ secret: string }>('/keys', { name, expires_in_days: expires ? Number(expires) : null });
      setSecret(r.secret);
      setCopied(false);
      setName('');
      await load();
    } catch (err) { setError(err); }
  };

  const revoke = async (k: KeyView) => {
    if (!window.confirm(`Revoke "${k.name}"? Requests using it will fail immediately.`)) return;
    try { await api.post(`/keys/${k.id}/revoke`); await load(); } catch (err) { setError(err); }
  };

  return (
    <>
      <header className="page-head"><h1>API keys</h1></header>
      <ErrorNote error={error} />
      {secret && (
        <div className="card secret">
          <h2>Your new key</h2>
          <p><strong>Copy it now.</strong> It is shown once and cannot be recovered. Store it in an environment variable, not in source code.</p>
          <code className="secret-value">{secret}</code>
          <div className="row">
            <button className="primary" onClick={async () => { await navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={() => setSecret(null)}>I have stored it</button>
          </div>
        </div>
      )}
      <form className="card row wrap" onSubmit={create}>
        <label className="grow">Key name<input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop" required /></label>
        <label>Expires
          <select value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="">Never</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
          </select>
        </label>
        <button className="primary">Create key</button>
      </form>
      <section className="card">
        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Models</th><th>Status</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={k.status === 'revoked' ? 'dim' : ''}>
                <td>{k.name}</td><td><code>{k.display}</code></td><td>{k.models.join(', ')}</td>
                <td><span className={`badge ${k.status}`}>{k.status}</span></td>
                <td>{when(k.created_at)}</td><td>{when(k.last_used_at)}</td><td>{when(k.expires_at)}</td>
                <td>{k.status === 'active' && <button className="danger small" onClick={() => revoke(k)}>Revoke</button>}</td>
              </tr>
            ))}
            {keys.length === 0 && <tr><td colSpan={8} className="muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

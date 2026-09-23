import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, credits, when, type KeyView, type LedgerEntry, type User, type WalletView } from '../api';
import { ErrorNote, useSession } from '../App';

interface Detail { user: User; wallet: WalletView; keys: KeyView[]; usage: { requests: number; charged_units: number }; ledger: LedgerEntry[] }

export default function AdminUser() {
  const { id } = useParams();
  const { me } = useSession();
  const [d, setD] = useState<Detail | null>(null);
  const [amount, setAmount] = useState('10');
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState('');
  const [adjReason, setAdjReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');

  const load = async () => { try { setD(await api.get<Detail>(`/admin/users/${id}`)); } catch (e) { setError(e); } };
  useEffect(() => { load(); }, [id]);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null); setNotice('');
    try { await fn(); setNotice(msg); await load(); } catch (e) { setError(e); }
  };

  const grant = (e: FormEvent) => {
    e.preventDefault();
    act(() => api.post(`/admin/users/${id}/credits`, { credits: Number(amount), reason }), `Granted ${amount} credits.`);
    setReason('');
  };
  const doAdjust = (e: FormEvent) => {
    e.preventDefault();
    act(() => api.post(`/admin/users/${id}/adjust`, { delta_units: Math.round(Number(adjust) * 1000), reason: adjReason }), 'Adjustment recorded.');
    setAdjust(''); setAdjReason('');
  };
  const setStatus = (status: 'active' | 'disabled') => {
    const why = window.prompt(`Reason for ${status === 'disabled' ? 'disabling (revokes all keys)' : 're-enabling'} this account:`);
    if (why) act(() => api.post(`/admin/users/${id}/status`, { status, reason: why }), `Account ${status}.`);
  };

  if (!d) return <><ErrorNote error={error} /><div className="muted">Loading…</div></>;
  return (
    <>
      <header className="page-head"><h1>{d.user.email}</h1>
        <span className={`badge ${d.user.status}`}>{d.user.status}</span><span className="badge">{d.user.role}</span></header>
      <ErrorNote error={error} />
      {notice && <div className="alert info">{notice}</div>}
      <section className="stats">
        <div className="stat"><div className="label">Balance</div><div className="value">{credits(d.wallet.balance_units)}</div></div>
        <div className="stat"><div className="label">Reserved</div><div className="value">{credits(d.wallet.reserved_units)}</div></div>
        <div className="stat"><div className="label">Available</div><div className="value">{credits(d.wallet.available_units)}</div></div>
        <div className="stat"><div className="label">Requests / charged</div><div className="value small-value">{d.usage.requests} / {credits(d.usage.charged_units)}</div></div>
      </section>
      <div className="grid2">
        <form className="card" onSubmit={grant}>
          <h2>Grant credits</h2>
          <label>Credits<input type="number" min="0.001" step="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <label>Reason (recorded permanently)<input value={reason} minLength={3} onChange={(e) => setReason(e.target.value)} required /></label>
          <button className="primary">Grant</button>
        </form>
        <form className="card" onSubmit={doAdjust}>
          <h2>Adjust (correction)</h2>
          <label>Credits (+/-)<input type="number" step="0.001" value={adjust} onChange={(e) => setAdjust(e.target.value)} required /></label>
          <label>Reason<input value={adjReason} minLength={3} onChange={(e) => setAdjReason(e.target.value)} required /></label>
          <button>Record adjustment</button>
          <p className="muted small">Cannot reduce the balance below active reservations.</p>
        </form>
      </div>
      {d.user.id !== me?.user.id && (
        <section className="card row">
          {d.user.status === 'active'
            ? <button className="danger" onClick={() => setStatus('disabled')}>Disable account and revoke keys</button>
            : <button onClick={() => setStatus('active')}>Re-enable account</button>}
        </section>
      )}
      <section className="card"><h2>API keys</h2>
        <table><thead><tr><th>Name</th><th>Key</th><th>Status</th><th>Last used</th></tr></thead>
          <tbody>{d.keys.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.display}</code></td><td>{k.status}</td><td>{when(k.last_used_at)}</td></tr>)}</tbody></table>
      </section>
      <section className="card"><h2>Transaction history (immutable)</h2>
        <table><thead><tr><th>Time</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reason</th><th>Actor</th></tr></thead>
          <tbody>{d.ledger.map((e) => (
            <tr key={e.id}><td>{when(e.created_at)}</td><td>{e.kind}</td><td className={e.amount_units < 0 ? 'neg' : 'pos'}>{credits(e.amount_units)}</td>
              <td>{credits(e.balance_after_units)}</td><td className="small">{e.reason}</td><td className="small muted">{e.actor_user_id ? e.actor_user_id.slice(0, 8) : 'system'}</td></tr>
          ))}</tbody></table>
      </section>
    </>
  );
}

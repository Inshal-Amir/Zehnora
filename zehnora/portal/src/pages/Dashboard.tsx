import { useEffect, useState } from 'react';
import brand from '@brand/brand.json';
import { api, credits, when, type LedgerEntry, type UsageRow, type WalletView } from '../api';
import { ErrorNote } from '../App';

interface UsageResp { totals: { requests: number; input_tokens: number; output_tokens: number; charged_units: number; errors: number }; requests: UsageRow[] }

export default function Dashboard() {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [usage, setUsage] = useState<UsageResp | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const w = await api.get<{ wallet: WalletView; ledger: LedgerEntry[] }>('/wallet');
      setWallet(w.wallet);
      setLedger(w.ledger);
      setUsage(await api.get<UsageResp>('/usage'));
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const per = wallet?.units_per_credit ?? 1000;
  return (
    <>
      <header className="page-head"><h1>Usage</h1><button onClick={load}>Refresh</button></header>
      <ErrorNote error={error} />
      <section className="stats">
        <div className="stat"><div className="label">Available credits</div><div className="value">{wallet ? credits(wallet.available_units, per) : '—'}</div></div>
        <div className="stat"><div className="label">Reserved (in-flight)</div><div className="value">{wallet ? credits(wallet.reserved_units, per) : '—'}</div></div>
        <div className="stat"><div className="label">Requests</div><div className="value">{usage?.totals.requests ?? '—'}</div></div>
        <div className="stat"><div className="label">Errors</div><div className="value">{usage?.totals.errors ?? '—'}</div></div>
      </section>
      <p className="muted small">{brand.creditsNotice} 1 credit = {per.toLocaleString()} units. Credits are demonstration units, not money.</p>
      {wallet && wallet.available_units === 0 && <div className="alert info">You have no credits yet. Ask the administrator to grant demo credits, then create an API key.</div>}

      <section className="card">
        <h2>Recent requests</h2>
        <table>
          <thead><tr><th>Time</th><th>Model</th><th>Source</th><th>State</th><th>Tokens in / out</th><th>Charged</th><th>Error</th></tr></thead>
          <tbody>
            {usage?.requests.slice(0, 25).map((r) => (
              <tr key={r.id}>
                <td>{when(r.created_at)}</td><td>{r.model}{r.stream ? ' (stream)' : ''}</td><td>{r.source}</td>
                <td><span className={`badge ${r.state}`}>{r.state}</span></td>
                <td>{r.input_tokens ?? '—'} / {r.output_tokens ?? '—'}</td>
                <td>{r.charged_units == null ? '—' : credits(r.charged_units, per)}</td>
                <td className="small">{r.error_code ?? ''}</td>
              </tr>
            ))}
            {usage && usage.requests.length === 0 && <tr><td colSpan={7} className="muted">No requests yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Credit history</h2>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reason</th></tr></thead>
          <tbody>
            {ledger.map((e) => (
              <tr key={e.id}><td>{when(e.created_at)}</td><td>{e.kind}</td><td className={e.amount_units < 0 ? 'neg' : 'pos'}>{credits(e.amount_units, per)}</td>
                <td>{credits(e.balance_after_units, per)}</td><td className="small">{e.reason}</td></tr>
            ))}
            {ledger.length === 0 && <tr><td colSpan={5} className="muted">No credit activity yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

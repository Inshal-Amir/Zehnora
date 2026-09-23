import { useEffect, useState } from 'react';
import { api, credits, when } from '../api';
import { ErrorNote } from '../App';

interface AdminModel {
  id: string; alias: string; deployment_identity: string; visible: boolean; available: boolean; context_limit: number;
  max_output_tokens: number; rates: { version: number; input: number; output: number; effective_from: string }[];
}
interface Req { id: string; user_id: string; model: string; source: string; state: string; reserved_units: number; note: string | null; created_at: string }
interface Err { code: string; count: number; last_seen: string }
interface Audit { id: number; actor: string | null; action: string; target_type: string | null; target_id: string | null; created_at: string }

export default function AdminSystem() {
  const [models, setModels] = useState<AdminModel[]>([]);
  const [profile, setProfile] = useState('');
  const [pending, setPending] = useState<Req[]>([]);
  const [errors, setErrors] = useState<Err[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const m = await api.get<{ models: AdminModel[]; profile: string }>('/admin/models');
      setModels(m.models); setProfile(m.profile);
      setPending((await api.get<{ requests: Req[] }>('/admin/requests?state=pending_reconciliation')).requests);
      setErrors((await api.get<{ errors: Err[] }>('/admin/errors')).errors);
      setAudit((await api.get<{ events: Audit[] }>('/admin/audit')).events);
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (m: AdminModel, field: 'visible' | 'available') => {
    try { await api.patch(`/admin/models/${m.id}`, { [field]: !m[field] }); await load(); } catch (e) { setError(e); }
  };
  const newRate = async (m: AdminModel) => {
    const inp = window.prompt('Input units per token', String(m.rates.at(-1)?.input ?? 1));
    const out = inp === null ? null : window.prompt('Output units per token', String(m.rates.at(-1)?.output ?? 2));
    if (inp === null || out === null) return;
    try { await api.post(`/admin/models/${m.id}/rates`, { input_units_per_token: Number(inp), output_units_per_token: Number(out) }); await load(); }
    catch (e) { setError(e); }
  };
  const resolve = async (r: Req, action: 'settle' | 'release') => {
    const reason = window.prompt(`Reason for ${action} (e.g. usage verified in gateway logs):`);
    if (!reason) return;
    const body: Record<string, unknown> = { action, reason };
    if (action === 'settle') {
      body.input_tokens = Number(window.prompt('Verified input tokens', '0'));
      body.output_tokens = Number(window.prompt('Verified output tokens', '0'));
    }
    try { await api.post(`/admin/requests/${r.id}/resolve`, body); await load(); } catch (e) { setError(e); }
  };

  return (
    <>
      <header className="page-head"><h1>Models &amp; requests</h1><span className="badge warn">profile: {profile}</span></header>
      <ErrorNote error={error} />
      <section className="card"><h2>Model catalog</h2>
        <table><thead><tr><th>Alias</th><th>Actual deployment</th><th>Context / max out</th><th>Current rate</th><th>Visible</th><th>Available</th><th /></tr></thead>
          <tbody>{models.map((m) => {
            const r = m.rates.at(-1);
            return (
              <tr key={m.id}><td><code>{m.alias}</code></td><td className="small">{m.deployment_identity}</td>
                <td>{m.context_limit} / {m.max_output_tokens}</td><td>v{r?.version}: {r?.input} in / {r?.output} out</td>
                <td><button className="small" onClick={() => toggle(m, 'visible')}>{m.visible ? 'yes' : 'no'}</button></td>
                <td><button className="small" onClick={() => toggle(m, 'available')}>{m.available ? 'yes' : 'no'}</button></td>
                <td><button className="small" onClick={() => newRate(m)}>New rate version</button></td></tr>
            );
          })}</tbody></table>
        <p className="muted small">New rates apply to future requests only; each request stores the rate version it used.</p>
      </section>
      <section className="card"><h2>Pending reconciliation ({pending.length})</h2>
        <table><thead><tr><th>Time</th><th>Request</th><th>Model</th><th>Reserved</th><th>Note</th><th /></tr></thead>
          <tbody>{pending.map((r) => (
            <tr key={r.id}><td>{when(r.created_at)}</td><td><code>{r.id.slice(0, 8)}</code></td><td>{r.model}</td><td>{credits(r.reserved_units)}</td>
              <td className="small">{r.note}</td>
              <td className="row"><button className="small" onClick={() => resolve(r, 'settle')}>Settle</button>
                <button className="small" onClick={() => resolve(r, 'release')}>Release</button></td></tr>
          ))}{pending.length === 0 && <tr><td colSpan={6} className="muted">Nothing pending.</td></tr>}</tbody></table>
      </section>
      <section className="card"><h2>Recent errors</h2>
        <table><thead><tr><th>Code</th><th>Count</th><th>Last seen</th></tr></thead>
          <tbody>{errors.map((e) => <tr key={e.code}><td>{e.code}</td><td>{e.count}</td><td>{when(e.last_seen)}</td></tr>)}</tbody></table>
      </section>
      <section className="card"><h2>Audit log</h2>
        <table><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Actor</th></tr></thead>
          <tbody>{audit.slice(0, 50).map((a) => (
            <tr key={a.id}><td>{when(a.created_at)}</td><td>{a.action}</td><td className="small">{a.target_type} {a.target_id?.slice(0, 8)}</td>
              <td className="small muted">{a.actor ? a.actor.slice(0, 8) : 'system'}</td></tr>
          ))}</tbody></table>
      </section>
    </>
  );
}

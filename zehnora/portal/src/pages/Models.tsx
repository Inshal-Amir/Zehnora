import { useEffect, useState } from 'react';
import { api, type ModelInfo } from '../api';
import { ErrorNote } from '../App';

export default function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<{ models: ModelInfo[]; note: string }>('/models').then((r) => { setModels(r.models); setNote(r.note); }).catch(setError);
  }, []);
  return (
    <>
      <header className="page-head"><h1>Models</h1></header>
      <ErrorNote error={error} />
      <section className="card">
        <table>
          <thead><tr><th>Model</th><th>Status</th><th>Tested context</th><th>Max output</th><th>Input rate</th><th>Output rate</th></tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.alias}>
                <td><code>{m.alias}</code><div className="muted small">{m.description}</div></td>
                <td><span className={`badge ${m.available ? 'active' : 'revoked'}`}>{m.available ? 'available' : 'unavailable'}</span></td>
                <td>{m.context_limit.toLocaleString()} tokens</td><td>{m.max_output_tokens.toLocaleString()} tokens</td>
                <td>{m.input_units_per_token} unit / token</td><td>{m.output_units_per_token} units / token</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{note} Example: 100 input + 200 output tokens at 1/2 units = 500 units = 0.5 credits. Rates are our demo rates, not market prices.</p>
      </section>
    </>
  );
}

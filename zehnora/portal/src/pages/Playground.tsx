import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, when } from '../api';
import { ErrorNote } from '../App';

interface Conv { id: string; title: string; model: string; updated_at: string }
interface Msg { id: string; role: string; content: string; created_at: string }

export default function Playground() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);

  const loadList = async () => setConvs((await api.get<{ conversations: Conv[] }>('/playground/conversations')).conversations);
  const loadConv = async (cid: string) => setMessages((await api.get<{ messages: Msg[] }>(`/playground/conversations/${cid}`)).messages);

  useEffect(() => { loadList().catch(setError); }, []);
  useEffect(() => { if (id) loadConv(id).catch(setError); else setMessages([]); }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let cid = id;
      if (!cid) {
        cid = (await api.post<{ id: string }>('/playground/conversations', {})).id;
        navigate(`/playground/${cid}`, { replace: true });
      }
      const content = text;
      setMessages((m) => [...m, { id: 'pending', role: 'user', content, created_at: new Date().toISOString() }]);
      setText('');
      await api.post(`/playground/conversations/${cid}/messages`, { content });
      await loadConv(cid);
      await loadList();
    } catch (err) {
      setError(err);
      if (id) await loadConv(id);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (cid: string) => {
    if (!window.confirm('Delete this conversation permanently?')) return;
    try {
      await api.del(`/playground/conversations/${cid}`);
      if (cid === id) navigate('/playground');
      await loadList();
    } catch (err) { setError(err); }
  };

  return (
    <div className="playground">
      <aside className="conv-list">
        <button className="primary block" onClick={() => navigate('/playground')}>New conversation</button>
        {convs.map((c) => (
          <div key={c.id} className={`conv ${c.id === id ? 'active' : ''}`}>
            <button className="link grow left" onClick={() => navigate(`/playground/${c.id}`)} title={when(c.updated_at)}>{c.title}</button>
            <button className="link small danger-text" onClick={() => remove(c.id)} aria-label="Delete conversation">✕</button>
          </div>
        ))}
        <p className="muted small">Playground history is stored in your Zehnora account (PostgreSQL). It is separate from Zehnora Desktop chats.</p>
      </aside>
      <section className="chat">
        <div className="messages">
          {messages.length === 0 && <div className="muted center">Ask zehnora-coder something. Each message uses your credits.</div>}
          {messages.map((m) => (
            <div key={m.id + m.created_at} className={`msg ${m.role}`}><div className="bubble">{m.content}</div></div>
          ))}
          {busy && <div className="msg assistant"><div className="bubble muted">Thinking…</div></div>}
          <div ref={end} />
        </div>
        <ErrorNote error={error} />
        <form className="composer" onSubmit={send}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Message zehnora-coder" rows={2}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }} />
          <button className="primary" disabled={busy || !text.trim()}>Send</button>
        </form>
      </section>
    </div>
  );
}

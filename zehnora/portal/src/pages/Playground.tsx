import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowUp, Brain, ChevronRight, MessageSquare, SquarePen, Square, Trash2 } from 'lucide-react';
import { api, streamPost } from '../api';
import { ErrorNote, useSession } from '../App';
import Markdown, { CopyButton } from '../components/Markdown';

interface Conv { id: string; title: string; model: string; updated_at: string }
interface Msg { id: string; role: string; content: string; reasoning?: string; streaming?: boolean }

const SUGGESTIONS = [
  'Write a Python function that validates an email address, with tests',
  'Explain the difference between a process and a thread',
  'Review this SQL for performance: SELECT * FROM orders WHERE YEAR(created_at) = 2026',
  'Write a Dockerfile for a FastAPI app with a non-root user',
];

/** Models that think inline wrap reasoning in <think>…</think>; show it apart from the answer. */
function splitThinking(text: string): { reasoning: string; answer: string } {
  const open = text.indexOf('<think>');
  if (open === -1) return { reasoning: '', answer: text };
  const close = text.indexOf('</think>', open);
  if (close === -1) return { reasoning: text.slice(open + 7), answer: text.slice(0, open) };
  return { reasoning: text.slice(open + 7, close), answer: text.slice(0, open) + text.slice(close + 8) };
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thinking ${open ? 'open' : ''}`}>
      <button type="button" className="ghost thinking-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={14} /><span className={active ? 'shimmer' : ''}>{active ? 'Thinking…' : 'Thought process'}</span><ChevronRight size={14} className="chev" />
      </button>
      {open && <div className="thinking-body">{text.trim()}</div>}
    </div>
  );
}

function Message({ m }: { m: Msg }) {
  if (m.role === 'user') return <div className="msg user"><div className="bubble">{m.content}</div></div>;
  const inline = splitThinking(m.content);
  const reasoning = (m.reasoning ?? '') + inline.reasoning;
  const answer = inline.answer.trim();
  const thinking = !!m.streaming && !answer;
  return (
    <div className="msg assistant">
      {reasoning && <Thinking text={reasoning} active={thinking} />}
      {answer ? <Markdown text={answer} /> : m.streaming && !reasoning && <div className="dots"><span /><span /><span /></div>}
      {answer && !m.streaming && <div className="msg-actions"><CopyButton text={answer} /></div>}
    </div>
  );
}

export default function Playground() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);
  const createdHere = useRef<string | null>(null);

  const loadList = async () => setConvs((await api.get<{ conversations: Conv[] }>('/playground/conversations')).conversations);
  const loadConv = async (cid: string) => setMessages((await api.get<{ messages: Msg[] }>(`/playground/conversations/${cid}`)).messages);

  useEffect(() => { loadList().catch(setError); }, []);
  useEffect(() => {
    setError(null);
    if (id && id === createdHere.current) return;
    if (id) loadConv(id).catch(setError); else setMessages([]);
  }, [id]);
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = (fn: (m: Msg) => Msg) => setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

  const send = async (content: string) => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    const controller = new AbortController();
    abort.current = controller;
    let cid = id;
    try {
      if (!cid) {
        cid = (await api.post<{ id: string }>('/playground/conversations', {})).id;
        createdHere.current = cid;
        navigate(`/playground/${cid}`, { replace: true });
      }
      setMessages((ms) => [...ms, { id: `u-${Date.now()}`, role: 'user', content },
        { id: `a-${Date.now()}`, role: 'assistant', content: '', reasoning: '', streaming: true }]);
      await streamPost(`/playground/conversations/${cid}/messages`, { content, stream: true }, (d) =>
        patchLast((m) => ({ ...m, content: m.content + (d.content ?? ''), reasoning: (m.reasoning ?? '') + (d.reasoning ?? '') })), controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
    } finally {
      patchLast((m) => (m.role === 'assistant' ? { ...m, streaming: false } : m));
      setMessages((ms) => ms.filter((m) => m.role !== 'assistant' || m.content || m.reasoning));
      abort.current = null;
      setBusy(false);
      loadList().catch(() => {});
      refresh().catch(() => {});
      input.current?.focus();
    }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); send(text); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); }
  };

  const remove = async (cid: string) => {
    if (!window.confirm('Delete this conversation permanently?')) return;
    try {
      await api.del(`/playground/conversations/${cid}`);
      if (cid === id) navigate('/playground');
      await loadList();
    } catch (err) { setError(err); }
  };

  const empty = messages.length === 0;
  return (
    <div className="playground">
      <aside className="conv-pane">
        <button className="ghost new-chat" onClick={() => navigate('/playground')}><SquarePen size={16} />New chat</button>
        <div className="conv-heading">History</div>
        <div className="conv-scroll">
          {convs.map((c) => (
            <div key={c.id} className={`conv ${c.id === id ? 'active' : ''}`}>
              <button className="conv-title" onClick={() => navigate(`/playground/${c.id}`)} title={c.title}>{c.title}</button>
              <button className="ghost icon conv-del" onClick={() => remove(c.id)} aria-label="Delete conversation"><Trash2 size={14} /></button>
            </div>
          ))}
          {convs.length === 0 && <p className="muted small pad">No conversations yet.</p>}
        </div>
      </aside>

      <section className="chat">
        <div className="chat-top">
          <span className="model-pill"><MessageSquare size={14} />zehnora-coder</span>
        </div>
        <div className="messages" ref={scroller}>
          {empty ? (
            <div className="empty">
              <h2>What are we building today?</h2>
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy}>{s}</button>)}
              </div>
            </div>
          ) : (
            <div className="thread">{messages.map((m) => <Message key={m.id} m={m} />)}</div>
          )}
        </div>
        <div className="composer-wrap">
          <ErrorNote error={error} />
          <form className="composer" onSubmit={submit}>
            <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
                      placeholder="Message zehnora-coder" rows={1} aria-label="Message" autoFocus />
            {busy
              ? <button type="button" className="send stop" onClick={() => abort.current?.abort()} aria-label="Stop generating"><Square size={14} fill="currentColor" /></button>
              : <button className="send" disabled={!text.trim()} aria-label="Send"><ArrowUp size={18} /></button>}
          </form>
          <p className="muted tiny center-text">Runs on our own GPU. Each message uses credits. Answers can be wrong; check important code.</p>
        </div>
      </section>
    </div>
  );
}

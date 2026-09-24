import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="ghost icon-text" onClick={copy} aria-label={label}>
      {done ? <Check size={14} /> : <Copy size={14} />}<span>{done ? 'Copied' : label}</span>
    </button>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child && typeof child === 'object' && 'props' in child ? (child.props as { className?: string }).className : '') ?? '';
  const lang = className.replace('language-', '') || 'text';
  return (
    <div className="code-block">
      <div className="code-head"><span>{lang}</span><CopyButton text={textOf(children).replace(/\n$/, '')} /></div>
      <pre>{children}</pre>
    </div>
  );
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        pre: CodeBlock,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
      }}>{text}</ReactMarkdown>
    </div>
  );
}

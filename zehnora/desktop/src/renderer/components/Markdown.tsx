import { memo, useMemo } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { api } from '../state';

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').split(/\s/)[0];
      const known = language && hljs.getLanguage(language);
      const highlighted = known ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escapeHtml(text);
      return `<div class="code"><div class="code-bar"><span>${escapeHtml(language || 'text')}</span><button type="button" class="copy" data-copy>Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
    },
  },
});

function render(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-copy', 'target'] });
}

function handleClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  const copy = target.closest('[data-copy]');
  if (copy) {
    const code = copy.closest('.code')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard.writeText(code).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1400);
    });
    return;
  }
  const link = target.closest('a');
  if (link?.href) {
    event.preventDefault();
    api().openExternal(link.href);
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactElement {
  const html = useMemo(() => render(text), [text]);
  return <div className="markdown" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

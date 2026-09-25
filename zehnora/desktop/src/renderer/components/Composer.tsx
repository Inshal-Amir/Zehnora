import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { Mode } from '../../shared/types';
import { Icon } from './Icon';

const PLACEHOLDER: Record<Mode, string> = {
  chat: 'Message Zehnora…',
  work: 'Describe a task: build, fix, set up, search, run…',
};

export function Composer({ mode, running, disabled, onSend, onStop, seed }: {
  mode: Mode;
  running: boolean;
  disabled: boolean;
  onSend(text: string): void;
  onStop(): void;
  seed: { text: string; nonce: number } | null;
}): ReactElement {
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    area.current?.focus();
  }, [seed]);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, [mode]);

  const submit = (): void => {
    const value = text.trim();
    if (!value || running || disabled) return;
    onSend(value);
    setText('');
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      <div className={`composer ${mode}`}>
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={PLACEHOLDER[mode]}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          aria-label="Message"
        />
        {running ? (
          <button type="button" className="send stop" onClick={onStop} aria-label="Stop">
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button type="button" className="send" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send">
            <Icon name="send" size={17} />
          </button>
        )}
      </div>
      <div className="composer-hint">
        {mode === 'work' ? 'Work mode can change files and run programs on this computer. Risky actions ask you first.' : 'Zehnora can make mistakes. Check important information.'}
      </div>
    </div>
  );
}

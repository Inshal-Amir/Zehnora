import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ApprovalRequest, AssistantMessage, Message } from '../../shared/types';
import { ToolCard } from './ToolCard';
import { Markdown } from './Markdown';
import { Icon } from './Icon';

type Turn = { kind: 'user'; message: Message } | { kind: 'assistant'; id: string; steps: AssistantMessage[] };

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ kind: 'user', message });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last?.kind === 'assistant') last.steps.push(message);
    else turns.push({ kind: 'assistant', id: message.id, steps: [message] });
  }
  return turns;
}

function Reasoning({ text, live }: { text: string; live: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="brain" size={14} />
        <span className={live ? 'shimmer' : ''}>{live ? 'Thinking…' : 'Thought process'}</span>
        <Icon name="chevron" size={13} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

function Step({ step, approvals }: { step: AssistantMessage; approvals: Map<string, ApprovalRequest> }): ReactElement {
  const thinking = step.streaming && !step.content && !step.toolCalls.length;
  return (
    <div className="step">
      {step.reasoning && <Reasoning text={step.reasoning} live={Boolean(thinking)} />}
      {!step.reasoning && thinking && <div className="typing"><span /><span /><span /></div>}
      {step.content && <Markdown text={step.content} />}
      {step.toolCalls.length > 0 && (
        <div className="tools">
          {step.toolCalls.map((call) => <ToolCard key={call.id} call={call} approval={approvals.get(call.id)} />)}
        </div>
      )}
      {step.error && <div className="step-error" role="alert">{step.error}</div>}
    </div>
  );
}

export function Thread({ messages, approvals }: { messages: Message[]; approvals: ApprovalRequest[] }): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turns = useMemo(() => toTurns(messages), [messages]);
  const approvalByCall = useMemo(() => new Map(approvals.map((request) => [request.toolCallId, request])), [approvals]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = (): void => {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages, approvals]);

  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {turns.map((turn) =>
          turn.kind === 'user' ? (
            <div className="turn user" key={turn.message.id}>
              <div className="bubble">{turn.message.content}</div>
            </div>
          ) : (
            <div className="turn assistant" key={turn.id}>
              <div className="avatar" aria-hidden="true">Z</div>
              <div className="steps">
                {turn.steps.map((step) => <Step key={step.id} step={step} approvals={approvalByCall} />)}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

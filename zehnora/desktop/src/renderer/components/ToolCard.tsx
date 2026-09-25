import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ApprovalDecision, ApprovalRequest, ToolCall } from '../../shared/types';
import type { IconName } from './Icon';
import { Icon } from './Icon';
import { api } from '../state';

const TOOL_ICONS: Record<string, IconName> = {
  read_file: 'file',
  write_file: 'edit',
  edit_file: 'edit',
  list_directory: 'folder',
  find_files: 'search',
  search_text: 'search',
  create_directory: 'folder',
  move_path: 'folder',
  delete_path: 'trash',
  run_command: 'terminal',
  start_process: 'play',
  process_output: 'terminal',
  stop_process: 'stop',
  list_processes: 'terminal',
  web_search: 'globe',
  fetch_url: 'globe',
  github_search: 'github',
  github_repo: 'github',
  system_info: 'cpu',
  open: 'folder',
  check_web_page: 'globe',
  current_time: 'spark',
};

const STATUS_LABEL: Record<ToolCall['status'], string> = {
  pending: 'Preparing',
  'awaiting-approval': 'Needs approval',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  denied: 'Denied',
  cancelled: 'Cancelled',
};

function prettyArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.entries(parsed)
      .map(([key, value]) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return text.includes('\n') ? `${key}:\n${text}` : `${key}: ${text}`;
      })
      .join('\n');
  } catch {
    return raw;
  }
}

function fallbackLabel(call: ToolCall): string {
  try {
    const parsed = JSON.parse(call.arguments) as Record<string, string>;
    const first = parsed.command ?? parsed.path ?? parsed.query ?? parsed.url ?? parsed.repo ?? parsed.target ?? parsed.id;
    return first ? `${call.name.replace(/_/g, ' ')} · ${String(first).split('\n')[0]}` : call.name.replace(/_/g, ' ');
  } catch {
    return call.name.replace(/_/g, ' ');
  }
}

const duration = (call: ToolCall): string => (call.startedAt && call.endedAt ? `${((call.endedAt - call.startedAt) / 1000).toFixed(1)}s` : '');

function StatusMark({ status }: { status: ToolCall['status'] }): ReactElement {
  if (status === 'running' || status === 'pending') return <span className="spinner" aria-label={STATUS_LABEL[status]} />;
  if (status === 'done') return <Icon name="check" size={15} className="ok" />;
  if (status === 'awaiting-approval') return <Icon name="shield" size={15} className="warn" />;
  return <Icon name="x" size={15} className="bad" />;
}

function ApprovalBox({ request }: { request: ApprovalRequest }): ReactElement {
  const decide = (decision: ApprovalDecision): void => {
    api().decide(request.id, decision);
  };
  return (
    <div className="approval" role="alertdialog" aria-label="Approval needed">
      <div className="approval-head">
        <Icon name="shield" size={16} />
        <span>Zehnora wants to run a {request.reason === 'risky' ? 'risky ' : ''}action</span>
      </div>
      <pre className="approval-command">{request.title}</pre>
      {request.detail && <div className="approval-detail">{request.detail}</div>}
      {request.cwd && <div className="approval-detail">in {request.cwd}</div>}
      <div className="approval-actions">
        <button type="button" className="btn primary" onClick={() => decide('once')}>Allow</button>
        <button type="button" className="btn" onClick={() => decide('always')}>Always allow in this chat</button>
        <button type="button" className="btn danger" onClick={() => decide('deny')}>Deny</button>
      </div>
    </div>
  );
}

export function ToolCard({ call, approval }: { call: ToolCall; approval?: ApprovalRequest }): ReactElement {
  const [open, setOpen] = useState(false);
  const label = call.summary ?? fallbackLabel(call);
  return (
    <div className={`tool tool-${call.status}`}>
      <button type="button" className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={TOOL_ICONS[call.name] ?? 'spark'} size={15} className="tool-icon" />
        <span className="tool-label">{label}</span>
        <span className="tool-meta">{call.status === 'done' ? duration(call) : STATUS_LABEL[call.status]}</span>
        <StatusMark status={call.status} />
        <Icon name="chevron" size={14} className={`tool-chevron ${open ? 'open' : ''}`} />
      </button>
      {approval && <ApprovalBox request={approval} />}
      {open && (
        <div className="tool-body">
          <div className="tool-section">Input</div>
          <pre>{prettyArgs(call.arguments) || '(none)'}</pre>
          {call.result !== undefined && (
            <>
              <div className="tool-section">Output</div>
              <pre>{call.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

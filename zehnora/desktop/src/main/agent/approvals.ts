import crypto from 'node:crypto';
import type { AgentEvent, ApprovalDecision, ApprovalPolicy, ApprovalRequest, Risk } from '../../shared/types';

export function needsApproval(risk: Risk, policy: ApprovalPolicy): boolean {
  if (policy === 'never') return false;
  if (risk === 'risky') return true;
  return risk === 'normal' && policy === 'writes';
}

interface Pending {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export class Approvals {
  private readonly pending = new Map<string, Pending>();
  private readonly allowed = new Map<string, Set<string>>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  isAllowed(conversationId: string, key: string): boolean {
    return this.allowed.get(conversationId)?.has(key) ?? false;
  }

  request(input: Omit<ApprovalRequest, 'id'>, allowKey: string, signal: AbortSignal): Promise<ApprovalDecision> {
    const request: ApprovalRequest = { ...input, id: crypto.randomUUID() };
    return new Promise((resolve) => {
      const finish = (decision: ApprovalDecision): void => {
        if (!this.pending.delete(request.id)) return;
        signal.removeEventListener('abort', onAbort);
        if (decision === 'always') {
          const set = this.allowed.get(request.conversationId) ?? new Set<string>();
          set.add(allowKey);
          this.allowed.set(request.conversationId, set);
        }
        this.emit({ type: 'approval-resolved', id: request.id });
        resolve(decision);
      };
      const onAbort = (): void => finish('deny');
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(request.id, { request, resolve: finish });
      this.emit({ type: 'approval', request });
    });
  }

  decide(id: string, decision: ApprovalDecision): void {
    this.pending.get(id)?.resolve(decision);
  }

  open(): ApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  forget(conversationId: string): void {
    this.allowed.delete(conversationId);
  }
}

// Thin client for the Zehnora platform API (same origin, session cookie + CSRF header).

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|; )zehnora_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  const res = await fetch(`/platform/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, data?.request_id);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export interface User { id: string; email: string; role: 'user' | 'admin'; status: string; created_at: string }
export interface WalletView {
  balance_units: number; reserved_units: number; available_units: number;
  units_per_credit: number; available_credits: number; reserved_credits: number;
}
export interface Me { user: User; wallet: WalletView; profile: string; api_base_url: string }
export interface KeyView {
  id: string; name: string; display: string; models: string[]; status: string;
  created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null;
}
export interface LedgerEntry { id: number; kind: string; amount_units: number; balance_after_units: number; reason: string; created_at: string; actor_user_id?: string | null; operation_id?: string }
export interface UsageRow {
  id: string; model: string; source: string; state: string; stream: boolean; input_tokens: number | null;
  output_tokens: number | null; charged_units: number | null; reserved_units: number; error_code: string | null; created_at: string;
}
export interface ModelInfo {
  alias: string; description: string; available: boolean; context_limit: number; max_output_tokens: number;
  input_units_per_token: number; output_units_per_token: number; rate_version: number;
}

export const credits = (units: number, per = 1000) => (units / per).toLocaleString(undefined, { maximumFractionDigits: 3 });
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

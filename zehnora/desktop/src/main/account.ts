import os from 'node:os';
import type { AccountStatus } from '../shared/types';
import { getSettings, readSecret, saveSettings, writeSecret } from './settings';

interface PlatformError {
  error?: { message?: string; code?: string };
}

interface AuthResponse {
  user: { email: string };
  csrf_token: string;
}

interface WalletView {
  available_credits: number;
}

interface Session {
  token: string;
  csrf: string;
}

const SESSION_COOKIE = 'zehnora_session';
const CSRF_COOKIE = 'zehnora_csrf';

export class AccountError extends Error {}

function cookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const at = pair.indexOf('=');
    if (pair.slice(0, at).trim() === name) return decodeURIComponent(pair.slice(at + 1).trim());
  }
  return null;
}

async function platform<T>(path: string, init: RequestInit & { session?: Session } = {}): Promise<{ body: T; response: Response }> {
  const { session, ...rest } = init;
  const base = getSettings().consoleBase;
  let response: Response;
  try {
    response = await fetch(`${base}/platform/v1${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(session ? { cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`, 'x-csrf-token': session.csrf } : {}),
        ...rest.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AccountError(`Cannot reach ${base}. Check your internet connection; the Zehnora server may be offline.`);
  }
  const text = await response.text();
  let body: T & PlatformError;
  try {
    body = JSON.parse(text) as T & PlatformError;
  } catch {
    const offline = response.status === 530 || response.status === 502 || response.status === 503;
    throw new AccountError(offline ? 'The Zehnora server is offline right now. Try again later.' : `Unexpected answer from the server (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new AccountError(body.error?.message ?? `HTTP ${response.status}`);
  return { body, response };
}

function sessionFrom(response: Response, csrf: string): Session {
  const token = cookieValue(response, SESSION_COOKIE);
  if (!token) throw new AccountError('The server did not start a session.');
  return { token, csrf: cookieValue(response, CSRF_COOKIE) ?? csrf };
}

const storeSession = (session: Session): void => writeSecret('session', JSON.stringify(session));

function loadSession(): Session | null {
  const raw = readSecret('session');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

/** Signs in (or creates the account), then creates an API key for this computer and stores it in the OS keychain. */
export async function connect(email: string, password: string, create: boolean): Promise<AccountStatus> {
  const { body, response } = await platform<AuthResponse>(create ? '/auth/register' : '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const session = sessionFrom(response, body.csrf_token);
  storeSession(session);
  const name = `Zehnora Desktop · ${os.hostname().replace(/\.local$/, '')}`.slice(0, 100);
  const { body: key } = await platform<{ secret: string }>('/keys', { method: 'POST', session, body: JSON.stringify({ name }) });
  saveSettings({ apiKey: key.secret, accountEmail: body.user.email });
  return status();
}

export async function status(): Promise<AccountStatus> {
  const { accountEmail } = getSettings();
  const session = loadSession();
  if (!accountEmail || !session) return { email: accountEmail || null, credits: null };
  try {
    const { body } = await platform<{ wallet: WalletView }>('/me', { session });
    return { email: accountEmail, credits: body.wallet.available_credits };
  } catch {
    return { email: accountEmail, credits: null };
  }
}

export async function signOut(): Promise<void> {
  const session = loadSession();
  if (session) await platform('/auth/logout', { method: 'POST', session }).catch(() => undefined);
  writeSecret('session', '');
  saveSettings({ apiKey: '', accountEmail: '' });
}

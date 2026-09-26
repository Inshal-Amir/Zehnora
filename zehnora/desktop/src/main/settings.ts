import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { Settings, SettingsPatch } from '../shared/types';

type StoredSettings = Omit<Settings, 'hasApiKey' | 'hasGithubToken'>;
type SecretName = 'api-key' | 'github-token' | 'session';

const DEFAULTS: StoredSettings = {
  apiBase: process.env.ZEHNORA_API_BASE ?? 'https://api.dubg.dev/v1',
  consoleBase: process.env.ZEHNORA_CONSOLE_BASE ?? 'https://console.dubg.dev',
  accountEmail: '',
  model: process.env.ZEHNORA_MODEL ?? 'zehnora-coder',
  approvalPolicy: 'risky',
  defaultWorkDir: path.join(os.homedir(), 'Zehnora'),
  searxngUrl: '',
  contextTokens: 60_000,
  maxOutputTokens: 8192,
  theme: 'system',
};

const ENV_SECRETS: Record<SecretName, string | undefined> = {
  'api-key': process.env.ZEHNORA_API_KEY,
  'github-token': process.env.ZEHNORA_GITHUB_TOKEN,
  session: undefined,
};

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');
const secretFile = (name: SecretName): string => path.join(app.getPath('userData'), 'secrets', `${name}.bin`);

let cache: StoredSettings | null = null;

function load(): StoredSettings {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache as StoredSettings;
}

export function readSecret(name: SecretName): string | null {
  const fromEnv = ENV_SECRETS[name];
  if (fromEnv) return fromEnv;
  const file = secretFile(name);
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export function writeSecret(name: SecretName, value: string): void {
  const file = secretFile(name);
  if (!value) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available, so the secret cannot be stored safely.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, safeStorage.encryptString(value), { mode: 0o600 });
}

export function getSettings(): Settings {
  return { ...load(), hasApiKey: Boolean(readSecret('api-key')), hasGithubToken: Boolean(readSecret('github-token')) };
}

const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

export function saveSettings(patch: SettingsPatch): Settings {
  const { apiKey, githubToken, ...rest } = patch;
  if (apiKey !== undefined) {
    const key = apiKey.trim();
    if (key && !/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) throw new Error('That does not look like a Zehnora API key (sk-…).');
    writeSecret('api-key', key);
  }
  if (githubToken !== undefined) writeSecret('github-token', githubToken.trim());
  const next: StoredSettings = { ...load(), ...rest };
  next.apiBase = next.apiBase.trim().replace(/\/+$/, '');
  next.consoleBase = next.consoleBase.trim().replace(/\/+$/, '');
  next.contextTokens = clampInt(next.contextTokens, 8000, 1_000_000);
  next.maxOutputTokens = clampInt(next.maxOutputTokens, 256, 131_072);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  cache = next;
  return getSettings();
}

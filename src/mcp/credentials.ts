import type { CredentialStore } from '@earendil-works/pi-ai';
import { type McpServerConfig, placeholders } from './config.ts';

export const MCP_CREDENTIAL_PREFIX = 'mcp:';

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function credentialKey(server: string, url: string): Promise<string> {
  return `${MCP_CREDENTIAL_PREFIX}${server}|${await digest(new URL(url).href)}`;
}

export function secretNames(config: McpServerConfig): string[] {
  const names = new Set<string>();
  for (const value of Object.values(config.headers ?? {}))
    for (const name of placeholders(value)) names.add(name);
  return [...names];
}

export type Resolved =
  | { ok: true; headers: Record<string, string>; secrets: string[] }
  | { ok: false; missing: string[] };

export async function resolveHeaders(
  server: string,
  config: McpServerConfig,
  credentials: CredentialStore
): Promise<Resolved> {
  const names = secretNames(config);
  if (!names.length) return { ok: true, headers: { ...config.headers }, secrets: [] };
  const stored = await credentials.read(await credentialKey(server, config.url));
  const env = stored?.type === 'api_key' ? (stored.env ?? {}) : {};
  const key = stored?.type === 'api_key' ? stored.key : undefined;
  const value = (name: string) => env[name] ?? (names.length === 1 ? key : undefined);
  const missing = names.filter((name) => !value(name));
  if (missing.length) return { ok: false, missing };
  const headers: Record<string, string> = {};
  for (const [header, text] of Object.entries(config.headers ?? {}))
    headers[header] = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
      String(value(name))
    );
  return { ok: true, headers, secrets: names.map((name) => String(value(name))) };
}

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out;
}

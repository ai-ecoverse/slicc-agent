import { type McpServerConfig, placeholders } from './config.ts';

export const MCP_CREDENTIAL_PREFIX = 'mcp:';

export interface McpRecords {
  mcp(server: string, name?: string): { placeholder: string; state?: string } | undefined;
}

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

export function heldRecords(server: string, config: McpServerConfig, records: McpRecords) {
  const names = secretNames(config);
  if (!names.length) return [records.mcp(server)];
  return names.map(
    (name) => records.mcp(server, name) ?? (names.length === 1 ? records.mcp(server) : undefined)
  );
}

export type Resolved =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; missing: string[] };

export function resolveHeaders(
  server: string,
  config: McpServerConfig,
  records: McpRecords
): Resolved {
  const names = secretNames(config);
  if (!names.length) return { ok: true, headers: { ...config.headers } };
  const held = heldRecords(server, config, records);
  const placeholder = (name: string) => held[names.indexOf(name)]?.placeholder;
  const missing = names.filter((name) => !placeholder(name));
  if (missing.length) return { ok: false, missing };
  const headers: Record<string, string> = {};
  for (const [header, text] of Object.entries(config.headers ?? {}))
    headers[header] = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
      String(placeholder(name))
    );
  return { ok: true, headers };
}

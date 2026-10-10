import type { CodemodeTool } from '@earendil-works/pi-codemode';
import { defineDoc } from '@earendil-works/pi-durable';
import { mcpNamespace, nameMatcher } from './config.ts';

export const RESOURCE_NAMES: ReadonlySet<string> = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

export const McpAllowDoc = defineDoc<{ allow: string[] | null }>({
  kind: 'slicc.mcp',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ allow: null }),
});

export interface CodemodeExtra {
  tools: CodemodeTool[];
  globals: CodemodeTool[];
}

export function mcpEntries(names: readonly string[] | undefined): string[] | null {
  if (!names) return null;
  return names.filter((name) => name.startsWith('mcp__') || RESOURCE_NAMES.has(name));
}

export function allows(allow: readonly string[] | null, name: string): boolean {
  return allow === null || nameMatcher(allow)(name);
}

export function serverAllowed(allow: readonly string[] | null, server: string): boolean {
  if (allow === null) return true;
  const prefix = `${mcpNamespace(server)}__`;
  return allow.some((entry) => {
    if (entry.startsWith(prefix)) return true;
    if (!entry.includes('*')) return false;
    return prefix.startsWith(entry.slice(0, entry.indexOf('*')));
  });
}

import type { Context, JsonValue } from '@earendil-works/chord';
import { defineDoc } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { normalize } from '../kernel/paths.ts';

export { SPRINKLE_KIND, type Sprinkle } from './kind.ts';

export const SPRINKLES_DIR = '/home/sprinkles';
export const WELCOME = 'welcome';
export const WELCOMED = '/home/.welcomed';
export const DEFAULT_ICON = 'sparkles';

export type SprinkleMethod = 'readFile' | 'exists' | 'getState' | 'setState';

export const SprinklesDoc = defineDoc<{
  owners: Record<string, string>;
  state: Record<string, JsonValue>;
  welcomed: boolean;
}>({
  kind: 'slicc.sprinkles',
  version: 1,
  scope: 'session',
  initial: () => ({ owners: {}, state: {}, welcomed: false }),
});

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function describe(name: string, html: string): { title: string; icon: string } {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const icon =
    /<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']icon["']/i.exec(html)?.[1];
  return { title: title ? decode(title) : name, icon: icon ?? DEFAULT_ICON };
}

export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export async function sprinkleFiles(
  env: Pick<ExecutionEnv, 'listDir'>,
  dir: string,
  context: Context
): Promise<{ name: string; path: string }[]> {
  const listed = await env.listDir(dir, context);
  if (!listed.ok) return [];
  const out = new Map<string, string>();
  for (const entry of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.kind !== 'directory' && entry.name.endsWith('.shtml')) {
      const name = entry.name.slice(0, -'.shtml'.length);
      if (NAME.test(name)) out.set(name, `${dir}/${entry.name}`);
    }
    if (entry.kind === 'directory' && NAME.test(entry.name) && !out.has(entry.name)) {
      const inner = await env.listDir(`${dir}/${entry.name}`, context);
      if (inner.ok && inner.value.some((item) => item.name === `${entry.name}.shtml`))
        out.set(entry.name, `${dir}/${entry.name}/${entry.name}.shtml`);
    }
  }
  return [...out].map(([name, path]) => ({ name, path }));
}

export function homePath(path: unknown): string {
  if (typeof path !== 'string' || !path) throw new Error('a sprinkle reads files by absolute path');
  const mapped = path.startsWith('/shared/') ? `/home/${path.slice('/shared/'.length)}` : path;
  const segments = mapped.split('/');
  if (segments.includes('.') || segments.includes('..'))
    throw new Error(`a sprinkle reads paths without . or .. segments, not ${path}`);
  const resolved = normalize(mapped);
  if (resolved !== '/home' && !resolved.startsWith('/home/'))
    throw new Error(`a sprinkle can only read files in /home, not ${path}`);
  return resolved;
}

export const NO_EXEC =
  "sprinkles can't run commands in SLICC; send the agent a message with slicc.lick() and let it run them";

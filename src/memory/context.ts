import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export const CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
];
export const TRUSTED_ROOTS = ['/home', '/scoops'];
export const UNTRUSTED =
  'outside /home: mounted folders and other roots load once SLICC can trust a folder';

export type ContextFile = { path: string; content: string };
export type Skipped = { path: string; reason: string };
export type ContextFiles = { files: ContextFile[]; skipped: Skipped[] };

type Files = Pick<ExecutionEnv, 'readTextFile' | 'canonicalPath'>;

export function trusted(path: string): boolean {
  return TRUSTED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? '/' : dir.slice(0, cut);
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

async function fromDir(env: Files, dir: string, context: Context): Promise<ContextFile | null> {
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    const read = await env.readTextFile(path, context);
    if (read.ok) return { path, content: read.value.replace(/^﻿/, '') };
  }
  return null;
}

async function real(env: Files, path: string, context: Context): Promise<string> {
  const resolved = await env.canonicalPath(path, context);
  return resolved.ok ? resolved.value : path;
}

export async function loadContextFiles(
  env: Files,
  options: { cwd: string; agentDir: string; global?: boolean; project?: boolean },
  context: Context
): Promise<ContextFiles> {
  const files: ContextFile[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const accept = async (file: ContextFile, list: ContextFile[], front: boolean) => {
    if (seen.has(file.path)) return;
    seen.add(file.path);
    if (!trusted(file.path) || !trusted(await real(env, file.path, context))) {
      skipped.push({ path: file.path, reason: UNTRUSTED });
      return;
    }
    if (front) list.unshift(file);
    else list.push(file);
  };
  if (options.global !== false) {
    const global = await fromDir(env, options.agentDir, context);
    if (global) await accept(global, files, false);
  }
  if (options.project === false) return { files, skipped };
  const ancestors: ContextFile[] = [];
  let dir = options.cwd.replace(/\/+$/, '') || '/';
  for (;;) {
    const found = await fromDir(env, dir, context);
    if (found) await accept(found, ancestors, true);
    if (dir === '/') break;
    dir = parentOf(dir);
  }
  files.push(...ancestors);
  return { files, skipped: skipped.reverse() };
}

export function renderContextFiles({ files, skipped }: ContextFiles): string | undefined {
  const parts: string[] = [];
  if (files.length)
    parts.push(
      'Project-specific instructions and guidelines:',
      ...files.map(
        ({ path, content }) =>
          `<project_instructions path="${path}">\n${content}\n</project_instructions>`
      )
    );
  if (skipped.length)
    parts.push(
      [
        'Not loaded:',
        ...skipped.map(({ path, reason }) => `- ${path} (${reason})`),
        'Read one with your tools if the user asks you to follow it.',
      ].join('\n')
    );
  return parts.length ? parts.join('\n\n') : undefined;
}

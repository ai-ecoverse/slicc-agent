import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export const MAX_TEXT = 1024 * 1024;
export const MAX_FILES = 200;
export const SCAN_DEPTH = 3;
export const SCAN_ENTRIES = 200;
export const NO_GIT =
  "Changes needs git, and git isn't installed. Install it with `pnpm add -g @ai-ecoverse/wasm-git`, then run `git init` in a folder under /home, or clone with slicc-node or the extension connected.";
export const NO_REPO =
  'Changes lists the changes in git repositories, and there is none here yet. Run `git init` in a folder under /home, or clone one with slicc-node or the extension connected.';

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  path: string;
  repo: string;
  status: ChangeStatus;
  before: string | null;
  after: string | null;
}

export interface ChangesView {
  unavailable: string | null;
  changes: FileChange[];
}

export interface Pending {
  path: string;
  status: ChangeStatus;
}

export function parseStatus(out: string): Pending[] {
  const parts = out.split('\0');
  const found: Pending[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.length < 4) continue;
    const index = part[0] as string;
    const tree = part[1] as string;
    const path = part.slice(3);
    if (index === 'R' || index === 'C') i++;
    if (index === '?' && tree === '?') found.push({ path, status: 'added' });
    else if (tree === 'D') found.push({ path, status: 'deleted' });
    else if (tree === 'A') found.push({ path, status: 'added' });
    else if (tree !== ' ' && tree !== '!') found.push({ path, status: 'modified' });
  }
  return found;
}

export function textOf(bytes: Uint8Array): string | null {
  if (bytes.length > MAX_TEXT || bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function shown(text: string): string | null {
  return text.length > MAX_TEXT || text.includes('\0') || text.includes('�') ? null : text;
}

export function scanned(name: string): boolean {
  return name !== 'node_modules' && !name.startsWith('.');
}

export function within(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

export function relative(path: string, root: string): string {
  return root === '/' ? path.slice(1) : path.slice(root.length + 1);
}

export function joined(root: string, rel: string): string {
  return root === '/' ? `/${rel}` : `${root}/${rel}`;
}

export type Ran = { code: number; out: string; err: string };

export const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

export async function run(
  env: Pick<ExecutionEnv, 'exec'>,
  command: string | readonly string[],
  cwd: string,
  context: Context
): Promise<Ran> {
  let out = '';
  let err = '';
  const ran = await env.exec(
    typeof command === 'string' ? command : command.map(quote).join(' '),
    {
      cwd,
      onOutput: (text, _context, info) => {
        if (info.stream === 'stdout') out += text;
        else err += text;
      },
    },
    context
  );
  return ran.ok
    ? { code: ran.value.exitCode, out, err }
    : { code: -1, out, err: ran.error.message };
}

export function failure(ran: Ran, what: string): Error {
  return new Error(ran.err.trim() || ran.out.trim() || `${what} failed`);
}

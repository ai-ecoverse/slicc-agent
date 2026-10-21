import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export const MAX_TEXT = 1024 * 1024;
export const MAX_FILES = 200;
export const SCAN_DEPTH = 3;
export const SCAN_ENTRIES = 200;
export const CLONE_COMMAND = 'curl -fsSL https://get.sliccy.ai/slicc | sh';
export const NO_GIT =
  "Changes needs git, and git isn't installed. Install it with `pnpm add -g @ai-ecoverse/wasm-git`, then run `git init` in a folder under /home. To clone from the internet, link slicc or the SLICC extension.";
export const NO_REPO =
  'Changes lists the changes in git repositories, and there are none here yet. Run `git init` in a folder under /home. To clone from the internet, link slicc or the SLICC extension.';

export type ChangeStatus = 'added' | 'modified' | 'deleted';
export type ChangeKind = 'tracked' | 'untracked' | 'conflict';

const UNMERGED = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];

export interface FileChange {
  path: string;
  repo: string;
  status: ChangeStatus;
  kind: ChangeKind;
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
  kind: ChangeKind;
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
    if (UNMERGED.includes(index + tree)) found.push({ path, status: 'modified', kind: 'conflict' });
    else if (index === '?' && tree === '?')
      found.push({ path, status: 'added', kind: 'untracked' });
    else if (tree === 'D') found.push({ path, status: 'deleted', kind: 'tracked' });
    else if (tree === 'A') found.push({ path, status: 'added', kind: 'tracked' });
    else if (tree !== ' ' && tree !== '!')
      found.push({ path, status: 'modified', kind: 'tracked' });
  }
  return found;
}

export const STATUS = [
  'git',
  '--no-optional-locks',
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=all',
];

export const BATCH_BYTES = 4 * MAX_TEXT;

export interface Stored {
  path: string;
  oid: string;
  size: number;
}

const CHECKED = /^([0-9a-f]+) (\S+) (\d+)$/;

export function parseCheck(out: string, paths: readonly string[]): Stored[] | null {
  const lines = out.split('\n');
  if (lines.length !== paths.length + 1 || lines.at(-1) !== '') return null;
  const found: Stored[] = [];
  for (const [i, path] of paths.entries()) {
    const line = lines[i] as string;
    const match = CHECKED.exec(line);
    if (match?.[2] === 'blob')
      found.push({ path, oid: match[1] as string, size: Number(match[3]) });
    else if (!match && !line.endsWith(' missing') && !line.endsWith(' ambiguous')) return null;
  }
  return found;
}

const NEWLINE = 10;
const HEADER = /^[0-9a-f]+ (\S+) (\d+)$/;

export function parseBatch(bytes: Uint8Array, count: number): (Uint8Array | null)[] | null {
  const decoder = new TextDecoder();
  const out: (Uint8Array | null)[] = [];
  let at = 0;
  while (out.length < count) {
    const end = bytes.indexOf(NEWLINE, at);
    if (end < 0) return null;
    const header = decoder.decode(bytes.subarray(at, end));
    at = end + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      out.push(null);
      continue;
    }
    const match = HEADER.exec(header);
    if (!match) return null;
    const size = Number(match[2]);
    if (bytes[at + size] !== NEWLINE) return null;
    out.push(match[1] === 'blob' ? bytes.slice(at, at + size) : null);
    at += size + 1;
  }
  return at === bytes.length ? out : null;
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

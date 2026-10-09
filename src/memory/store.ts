import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { trusted } from './context.ts';
import {
  applyChange,
  byteLength,
  type Change,
  MAX_BYTES,
  MEMORY_FILE,
  type MemoryEntry,
  memoryEntries,
  parseMemory,
  redactSecrets,
  serializeMemory,
} from './format.ts';

export const GLOBAL = 'global';
export const ROLE_PREFIX = 'role:';

export type RoleMemory = { scope: 'user' | 'project'; path: string };

export type Place = { scope: string; file: string; label: string };

export type Written = {
  entry: MemoryEntry | null;
  found: boolean;
  bytes: number;
  redacted: number;
  file: string;
};

export function memoryRoot(home: string): string {
  return `${home}/.pi/agent/memory`;
}

export function roleRoot(home: string): string {
  return `${home}/.pi/agent/agent-memory`;
}

export function safePath(path: string): string | null {
  const parts = path.split('/');
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)))
    return null;
  return parts.join('/');
}

export function placeOf(home: string, scope: string): Place | null {
  if (scope === GLOBAL)
    return { scope, file: `${memoryRoot(home)}/${MEMORY_FILE}`, label: 'everyone' };
  if (scope.startsWith(ROLE_PREFIX)) {
    const path = safePath(scope.slice(ROLE_PREFIX.length));
    return path
      ? { scope, file: `${roleRoot(home)}/${path}/${MEMORY_FILE}`, label: `role ${path}` }
      : null;
  }
  const cone = safePath(scope);
  return cone && !cone.includes('/')
    ? { scope, file: `${memoryRoot(home)}/${cone}/${MEMORY_FILE}`, label: `cone ${cone}` }
    : null;
}

export async function projectRoot(
  env: Pick<ExecutionEnv, 'exists'>,
  cwd: string,
  context: Context
): Promise<string | null> {
  let dir = cwd.replace(/\/+$/, '') || '/';
  for (;;) {
    for (const marker of ['.pi', '.git']) {
      const found = await env.exists(`${dir === '/' ? '' : dir}/${marker}`, context);
      if (found.ok && found.value) return dir;
    }
    if (dir === '/') return null;
    const cut = dir.lastIndexOf('/');
    dir = cut <= 0 ? '/' : dir.slice(0, cut);
  }
}

export async function rolePlace(
  env: Pick<ExecutionEnv, 'exists'>,
  home: string,
  memory: RoleMemory,
  cwd: string,
  context: Context
): Promise<Place | { problem: string }> {
  const path = safePath(memory.path);
  if (!path) return { problem: `memory path "${memory.path}" is not a safe relative path` };
  if (memory.scope === 'user') return placeOf(home, `${ROLE_PREFIX}${path}`) as Place;
  const root = await projectRoot(env, cwd, context);
  if (!root) return { problem: `no project root (.pi or .git) above ${cwd}` };
  if (!trusted(root))
    return {
      problem: `the project root ${root} is outside /home; it gets memory once SLICC can trust a folder`,
    };
  return {
    scope: `${ROLE_PREFIX}${path}@${root}`,
    file: `${root}/.pi/agent-memory/${path}/${MEMORY_FILE}`,
    label: `role ${path} in ${root}`,
  };
}

type Files = Pick<
  ExecutionEnv,
  'readTextFile' | 'writeFile' | 'createDir' | 'canonicalPath' | 'fileInfo'
>;

function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/')) || '/';
}

export class MemoryFiles {
  readonly #env: Files;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(env: Files) {
    this.#env = env;
  }

  async #safe(file: string, context: Context): Promise<boolean> {
    for (let path = file; ; path = dirOf(path)) {
      const real = await this.#env.canonicalPath(path, context);
      if (real.ok) return real.value === path;
      if (path === '/') return true;
    }
  }

  async read(file: string, context: Context): Promise<{ text: string; updatedAt: number } | null> {
    if (!(await this.#safe(file, context))) return null;
    const read = await this.#env.readTextFile(file, context);
    if (!read.ok) return null;
    const info = await this.#env.fileInfo(file, context);
    return { text: read.value, updatedAt: info.ok ? info.value.mtimeMs : 0 };
  }

  async entries(place: Place, context: Context): Promise<MemoryEntry[]> {
    const read = await this.read(place.file, context);
    return read ? memoryEntries(parseMemory(read.text), place.scope, read.updatedAt) : [];
  }

  change(place: Place, change: Change, context: Context): Promise<Written> {
    const previous = this.#chains.get(place.file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#apply(place, change, context));
    this.#chains.set(place.file, next);
    void next
      .finally(() => {
        if (this.#chains.get(place.file) === next) this.#chains.delete(place.file);
      })
      .catch(() => undefined);
    return next;
  }

  async #apply(place: Place, change: Change, context: Context): Promise<Written> {
    if (!(await this.#safe(place.file, context)))
      throw new Error(`${place.file} is a symbolic link or under one; memory is not written there`);
    const read = await this.#env.readTextFile(place.file, context);
    const before = read.ok ? read.value : '';
    let redacted = 0;
    const clean = (text: string) => {
      const result = redactSecrets(text);
      redacted += result.count;
      return result.text;
    };
    const safe: Change =
      change.kind === 'save'
        ? {
            ...change,
            section: clean(change.section).trim() || 'Notes',
            title: clean(change.title).trim() || 'Untitled',
            body: clean(change.body),
          }
        : change;
    const { doc, found } = applyChange(parseMemory(before), place.scope, safe);
    const after = serializeMemory(doc);
    const bytes = byteLength(after);
    if (bytes > MAX_BYTES && bytes >= byteLength(before))
      throw new Error(
        `${place.file} would be ${bytes} bytes; memory files hold ${MAX_BYTES}. Remove or shorten entries first (a write over the limit must make the file smaller).`
      );
    if (change.kind === 'remove' && !found)
      return { entry: null, found, bytes: byteLength(before), redacted, file: place.file };
    await this.#env.createDir(dirOf(place.file), { recursive: true }, context);
    const written = await this.#env.writeFile(place.file, after, context);
    if (!written.ok) throw new Error(written.error.message);
    const entry =
      safe.kind === 'save'
        ? (memoryEntries(doc, place.scope, Date.now()).find(
            (item) =>
              item.source === 'entry' &&
              item.section.toLowerCase() === safe.section.toLowerCase() &&
              item.title.toLowerCase() === safe.title.toLowerCase()
          ) as MemoryEntry)
        : null;
    return { entry, found, bytes, redacted, file: place.file };
  }
}

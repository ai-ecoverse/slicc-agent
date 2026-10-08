import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv, FileWatcher, WatchChange } from '@earendil-works/pi-durable/env';
import { type ConfigError, parseWatch, type WatchEntry } from './config.ts';
import { glob } from './glob.ts';
import type { LickEvent } from './licks.ts';

const IGNORED = ['node_modules', '.git'];

interface Watching {
  json: string;
  entry: WatchEntry;
  match: (path: string) => boolean;
  watcher?: FileWatcher;
  timer?: ReturnType<typeof setTimeout>;
  paths: Set<string>;
}

export interface ConfigFiles {
  read(path: string, context: Context): Promise<string | undefined>;
  list(path: string, context: Context): Promise<string[]>;
}

export type Deliver = (event: LickEvent, context: Context) => Promise<void>;

export function relativeTo(base: string, path: string): string | undefined {
  if (path === base) return '';
  const prefix = base === '/' ? '/' : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

export function configFiles(env: ExecutionEnv): ConfigFiles {
  return {
    async read(path, context) {
      const result = await env.readTextFile(path, context);
      return result.ok ? result.value : undefined;
    },
    async list(path, context) {
      const result = await env.listDir(path, context);
      if (!result.ok) return [];
      return result.value
        .filter(
          (info) => info.kind === 'file' && !info.name.startsWith('.') && !info.name.endsWith('~')
        )
        .map((info) => info.name)
        .sort();
    },
  };
}

function title(entry: WatchEntry): string {
  return `${entry.name}: ${entry.path}/${entry.glob}`;
}

export class Watches {
  readonly #env: ExecutionEnv;
  readonly #deliver: Deliver;
  readonly #files: ConfigFiles;
  readonly #home: string;
  readonly #watching = new Map<string, Watching>();

  constructor(env: ExecutionEnv, deliver: Deliver, home: string) {
    this.#env = env;
    this.#deliver = deliver;
    this.#files = configFiles(env);
    this.#home = home;
  }

  get names(): string[] {
    return [...this.#watching.keys()];
  }

  async #fire(watch: Watching, context: Context): Promise<void> {
    const paths = [...watch.paths].sort();
    watch.paths.clear();
    if (!paths.length) return;
    const items: string[] = [];
    for (const path of paths) {
      const exists = await this.#env.exists(path, context);
      items.push(`${exists.ok && !exists.value ? 'gone' : 'changed'} ${path}`);
    }
    const { entry } = watch;
    const many = paths.length > 1;
    await this.#deliver(
      {
        channel: 'fswatch',
        source: entry.name,
        title: title(entry),
        text: `${paths.length} path${many ? 's' : ''} changed under ${entry.path} matching ${entry.glob}`,
        ...(entry.message ? { body: entry.message } : {}),
        items,
        target: entry.target,
      },
      context
    );
  }

  #paths(watch: Watching, paths: readonly string[], context: Context): void {
    for (const path of paths) {
      const relative = relativeTo(watch.entry.path, path);
      if (relative && watch.match(relative)) watch.paths.add(path);
    }
    if (!watch.paths.size) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      void this.#fire(watch, context).catch(() => undefined);
    }, watch.entry.debounce);
  }

  #changed(watch: Watching, change: WatchChange, context: Context): void {
    if ('paths' in change) {
      this.#paths(watch, change.paths, context);
      return;
    }
    const text =
      'overflow' in change
        ? 'Changes may have been missed for a while; look at the watched files again.'
        : `The watch stopped: ${change.error.message}. Save its file again to restart it.`;
    const { entry } = watch;
    void this.#deliver(
      { channel: 'fswatch', source: entry.name, title: title(entry), text, target: entry.target },
      context
    ).catch(() => undefined);
  }

  async #start(entry: WatchEntry, json: string, file: string, context: Context) {
    const watch: Watching = { json, entry, match: glob(entry.glob), paths: new Set() };
    const result = await this.#env.watch(
      [{ path: entry.path, recursive: true, exclude: { names: IGNORED } }],
      (change) => this.#changed(watch, change, context),
      context
    );
    if (!result.ok) return { file, error: `can't watch ${entry.path}: ${result.error.message}` };
    watch.watcher = result.value;
    this.#watching.set(entry.name, watch);
    return undefined;
  }

  async stop(name: string, context: Context): Promise<void> {
    const watch = this.#watching.get(name);
    if (!watch) return;
    this.#watching.delete(name);
    clearTimeout(watch.timer);
    await watch.watcher?.close(context);
  }

  async reconcile(dir: string, context: Context): Promise<ConfigError[]> {
    const errors: ConfigError[] = [];
    const seen = new Set<string>();
    for (const name of await this.#files.list(dir, context)) {
      const file = `${dir}/${name}`;
      const json = await this.#files.read(file, context);
      if (json === undefined) continue;
      let entry: WatchEntry;
      try {
        entry = parseWatch(file, json, this.#home);
      } catch (error) {
        errors.push({ file, error: (error as Error).message });
        continue;
      }
      seen.add(entry.name);
      if (this.#watching.get(entry.name)?.json === json) continue;
      await this.stop(entry.name, context);
      const failed = await this.#start(entry, json, file, context);
      if (failed) errors.push(failed);
    }
    for (const name of this.names) if (!seen.has(name)) await this.stop(name, context);
    return errors;
  }

  async close(context: Context): Promise<void> {
    for (const name of this.names) await this.stop(name, context);
  }
}

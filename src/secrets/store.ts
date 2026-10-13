import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

export interface PlainStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function memoryStore(): PlainStore {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(values.get(key)),
    async set(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, structuredClone(value));
    },
  };
}

export function fileStore(env: ExecutionEnv, path: string): PlainStore {
  let cache: Promise<Record<string, unknown>> | undefined;
  let writes: Promise<unknown> = Promise.resolve();
  const load = () => {
    cache ??= env.readTextFile(path, BACKGROUND_CONTEXT).then((read) => {
      if (!read.ok) return {};
      try {
        const parsed: unknown = JSON.parse(read.value);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    });
    return cache;
  };
  return {
    async get(key) {
      await writes;
      return structuredClone((await load())[key]);
    },
    set(key, value) {
      const write = writes.then(async () => {
        const all = { ...(await load()) };
        if (value === undefined) delete all[key];
        else all[key] = structuredClone(value);
        cache = Promise.resolve(all);
        const wrote = await env.writeFile(path, JSON.stringify(all), BACKGROUND_CONTEXT);
        if (!wrote.ok) throw new Error(`can't write ${path}`);
      });
      writes = write.catch(() => undefined);
      return write;
    },
  };
}

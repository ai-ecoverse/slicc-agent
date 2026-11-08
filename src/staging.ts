import { STAGED_ID, stagedDir } from './attachments.ts';
import { opfsDirectory } from './opfs-pool.ts';

export const STAGED_MS = 60 * 60 * 1000;

export interface Staging {
  take(id: string): Promise<Blob | undefined>;
  drop(id: string): Promise<void>;
  sweep(): Promise<void>;
  close(): void;
}

export interface StagingOptions {
  root?: () => Promise<FileSystemDirectoryHandle>;
  maxAgeMs?: number;
  now?: () => number;
}

export function workerStaging(serverId: string, options: StagingOptions = {}): Staging {
  const root = options.root ?? (() => navigator.storage.getDirectory());
  const maxAge = options.maxAgeMs ?? STAGED_MS;
  const now = options.now ?? Date.now;
  const dir = () =>
    Promise.resolve()
      .then(root)
      .then(
        (handle) => opfsDirectory(handle, stagedDir(serverId)),
        () => undefined
      );
  const drop = async (id: string) => {
    if (STAGED_ID.test(id)) await (await dir())?.removeEntry(id).catch(() => undefined);
  };
  const sweep = async () => {
    const found = await dir();
    if (!found) return;
    const stale: string[] = [];
    for await (const handle of found.values()) {
      if (handle.kind !== 'file') continue;
      const file = await (handle as FileSystemFileHandle).getFile().catch(() => undefined);
      if (file && file.lastModified <= now() - maxAge) stale.push(handle.name);
    }
    await Promise.all(stale.map((name) => found.removeEntry(name).catch(() => undefined)));
  };
  const timer = setInterval(() => void sweep(), maxAge);
  return {
    async take(id) {
      if (!STAGED_ID.test(id)) return undefined;
      const handle = await (await dir())?.getFileHandle(id).catch(() => undefined);
      return handle?.getFile().catch(() => undefined);
    },
    drop,
    sweep,
    close: () => clearInterval(timer),
  };
}

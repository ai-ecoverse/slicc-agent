export interface PoolAccess {
  root?: () => Promise<FileSystemDirectoryHandle>;
  locks?: LockManager;
  attempts?: number;
  delayMs?: number;
}

interface SyncAccessible {
  createSyncAccessHandle(): Promise<{ close(): void }>;
}

const names = new Map<string, string>();

export function vfsName(directory: string): string {
  let name = names.get(directory);
  if (!name) {
    name = `slicc-agent-${names.size}`;
    names.set(directory, name);
  }
  return name;
}

export function holdLock(locks: LockManager, name: string): Promise<() => void> {
  return new Promise((acquired, failed) => {
    locks
      .request(name, { mode: 'exclusive' }, () => new Promise<void>((release) => acquired(release)))
      .catch(failed);
  });
}

async function opaque(
  root: FileSystemDirectoryHandle,
  directory: string
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = root;
  try {
    for (const part of [...directory.split('/').filter(Boolean), '.opaque']) {
      dir = await dir.getDirectoryHandle(part);
    }
  } catch {
    return undefined;
  }
  return dir;
}

async function acquirable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file') continue;
    try {
      const access = await (handle as unknown as SyncAccessible).createSyncAccessHandle();
      access.close();
    } catch {
      return false;
    }
  }
  return true;
}

const pause = (ms: number) => new Promise((resume) => setTimeout(resume, ms));

export async function settlePool(directory: string, access: PoolAccess = {}): Promise<void> {
  const root = await (access.root ?? (() => navigator.storage.getDirectory()))();
  const dir = await opaque(root, directory);
  if (!dir) return;
  const attempts = access.attempts ?? 50;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await acquirable(dir)) return;
    if (attempt < attempts) await pause(access.delayMs ?? 100);
  }
  throw new Error(`SQLite pool ${directory} is still in use by another worker`);
}

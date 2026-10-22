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

const opfsRoot = () => navigator.storage.getDirectory();

export async function opfsDirectory(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = root;
  try {
    for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
  } catch {
    return undefined;
  }
  return dir;
}

export async function opfsFile(
  path: string,
  root: () => Promise<FileSystemDirectoryHandle> = opfsRoot
): Promise<File | undefined> {
  const at = path.lastIndexOf('/');
  const dir = await Promise.resolve()
    .then(root)
    .then(
      (handle) => opfsDirectory(handle, path.slice(0, at)),
      () => undefined
    );
  return dir
    ?.getFileHandle(path.slice(at + 1))
    .then((handle) => handle.getFile())
    .catch(() => undefined);
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
  const root = await (access.root ?? opfsRoot)();
  const dir = await opfsDirectory(root, `${directory}/.opaque`);
  if (!dir) return;
  const attempts = access.attempts ?? 50;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await acquirable(dir)) return;
    if (attempt < attempts) await pause(access.delayMs ?? 100);
  }
  throw new Error(`SQLite pool ${directory} is still in use by another worker`);
}

export interface Profile {
  durableSchema: number;
  agent: string;
}

export function profilePath(directory: string): string {
  return `${directory.replace(/\/+$/, '')}-profile.json`;
}

async function readProfile(file: FileSystemFileHandle): Promise<Partial<Profile>> {
  try {
    const parsed: unknown = JSON.parse(await (await file.getFile()).text());
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Profile>) : {};
  } catch {
    return {};
  }
}

export async function writeProfile(
  directory: string,
  durableSchema: number,
  agent: string,
  access: PoolAccess = {}
): Promise<Profile> {
  const path = profilePath(directory);
  const at = path.lastIndexOf('/');
  let dir = await (access.root ?? opfsRoot)();
  for (const part of path.slice(0, at).split('/').filter(Boolean))
    dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(path.slice(at + 1), { create: true });
  const known = (await readProfile(file)).durableSchema;
  const profile = {
    durableSchema:
      typeof known === 'number' && Number.isFinite(known) && known > durableSchema
        ? known
        : durableSchema,
    agent,
  };
  const writable = await file.createWritable();
  await writable.write(`${JSON.stringify(profile)}\n`);
  await writable.close();
  return profile;
}

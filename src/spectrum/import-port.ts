import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import type { ImportPreview, ImportProgress } from '../freezer/v6.ts';
import { IMPORTS_DIR } from '../layout.ts';
import { opfsDirectory } from '../opfs-pool.ts';

export const DATA_MAX = 16 * 1024 * 1024;

export type ShownPreview = Omit<ImportPreview, 'exportId' | 'createdAt'> & { createdAt: number };

export interface ShownImport {
  preview: ShownPreview | null;
  cones: string[];
  report: string | null;
  text: string;
}

export const IDLE_IMPORT: ImportProgress = { phase: 'idle', done: 0, total: 0, text: '' };

type Upload = { upload: string | null; data: string | null; done(): Promise<void> };

const TOO_BIG =
  'This profile is too big to send from this device. Import it in the browser that runs SLICC, or with freezer import there.';

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(out);
}

export async function upload(
  file: Blob,
  root: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory()
): Promise<Upload> {
  const dir = await Promise.resolve()
    .then(root)
    .then(
      (handle) => opfsDirectory(handle, IMPORTS_DIR),
      () => undefined
    );
  if (dir) {
    const id = crypto.randomUUID();
    const name = `upload-${id}.zip`;
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await file.stream().pipeTo(writable);
    const done = () => dir.removeEntry(name).catch(() => undefined);
    return { upload: id, data: null, done };
  }
  if (file.size > DATA_MAX) throw new Error(TOO_BIG);
  const data = base64(new Uint8Array(await file.arrayBuffer()));
  return { upload: null, data, done: async () => undefined };
}

function sentence(text: string): string {
  const said = text.trim().replace(/^./, (first) => first.toUpperCase());
  return /[.!?]$/.test(said) ? said : `${said}.`;
}

export function shownPreview({ exportId: _, createdAt, ...rest }: ImportPreview): ShownPreview {
  return { ...rest, createdAt: Date.parse(createdAt) };
}

export const LISTED_MS = 10_000;

export function listed(
  connection: Pick<AgentConnection, 'frozen'>,
  ids: readonly string[],
  ms = LISTED_MS
): Promise<void> {
  const frozen = connection.frozen;
  if (!frozen) return Promise.resolve();
  const shown = () =>
    ids.every((id) => (frozen.value ?? []).some((row) => row.id === id && row.v6));
  if (shown()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const off = frozen.subscribe(() => {
      if (shown()) done();
    });
  });
}

export async function importProfile(
  connection: Pick<AgentConnection, 'control' | 'frozen'>,
  file: Blob,
  options: { preview: boolean; again?: boolean },
  root?: () => Promise<FileSystemDirectoryHandle>
): Promise<ShownImport> {
  const sent = await upload(file, root);
  try {
    const answer = await connection.control.importProfile(
      {
        upload: sent.upload,
        data: sent.data,
        again: options.again === true,
        preview: options.preview,
      },
      BACKGROUND_CONTEXT
    );
    if (answer.error) throw new Error(sentence(answer.error));
    await listed(connection, answer.cones);
    return {
      preview: answer.preview ? shownPreview(answer.preview) : null,
      cones: answer.cones,
      report: answer.report,
      text: answer.text.trim(),
    };
  } finally {
    await sent.done();
  }
}

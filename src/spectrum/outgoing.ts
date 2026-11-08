import type { Attachment } from '@ai-ecoverse/slicc-spectrum/ui';
import {
  type AttachmentKind,
  FILE_LIMIT,
  fromBase64,
  IMAGE_LIMIT,
  INLINE_LIMIT,
  INLINE_TOTAL,
  REF,
  type SendAttachment,
  stagedDir,
  TOTAL_LIMIT,
  textBytes,
  together,
  tooLarge,
} from '../attachments.ts';
import { base64, type Shrink, shrink } from '../images/fit.ts';
import { opfsDirectory } from '../opfs-pool.ts';
import type { ImageRef, StoredImage } from '../services.ts';

export type Read = (url: string) => Promise<Blob>;

export type Stored = (ref: ImageRef) => Promise<StoredImage>;

export type Stage = (body: Blob) => Promise<string>;

export type AttachmentLimits = Partial<Record<AttachmentKind | 'secret' | 'total', number>>;

export interface Stager {
  stage: Stage;
  clear(): Promise<void>;
}

export const readUrl: Read = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.blob();
};

export function limitsOf(staging: boolean): AttachmentLimits {
  const each = staging ? FILE_LIMIT : INLINE_LIMIT;
  return { image: each, text: each, file: each, total: staging ? TOTAL_LIMIT : INLINE_TOTAL };
}

export function stagingDir(
  serverId: string,
  root: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory()
): Promise<FileSystemDirectoryHandle | undefined> {
  return Promise.resolve()
    .then(root)
    .then(
      (handle) => opfsDirectory(handle, stagedDir(serverId)),
      () => undefined
    );
}

export function stager(dir: FileSystemDirectoryHandle): Stager {
  const names: string[] = [];
  return {
    async stage(body) {
      const id = crypto.randomUUID();
      names.push(id);
      const writable = await (await dir.getFileHandle(id, { create: true })).createWritable();
      await body.stream().pipeTo(writable);
      return id;
    },
    async clear() {
      await Promise.all(
        names.splice(0).map((name) => dir.removeEntry(name).catch(() => undefined))
      );
    },
  };
}

const KINDS = new Set<string>(['image', 'text', 'file']);

type Base = Omit<SendAttachment, 'data' | 'text' | 'upload'>;

interface Carry {
  stage: Stage | undefined;
  inline: number;
  all: number;
}

async function carried(base: Base, body: Blob, carry: Carry): Promise<SendAttachment> {
  carry.all += body.size;
  if (carry.stage && carry.all > TOTAL_LIMIT) throw new Error(together(TOTAL_LIMIT));
  if (body.size <= INLINE_LIMIT && carry.inline + body.size <= INLINE_TOTAL) {
    carry.inline += body.size;
    return { ...base, data: base64(new Uint8Array(await body.arrayBuffer())) };
  }
  if (!carry.stage)
    throw new Error(
      body.size > INLINE_LIMIT ? tooLarge(base.name, INLINE_LIMIT) : together(INLINE_TOTAL)
    );
  if (body.size > FILE_LIMIT) throw new Error(tooLarge(base.name, FILE_LIMIT));
  return { ...base, upload: await carry.stage(body) };
}

async function fitted(
  attachment: Attachment,
  read: Read,
  fit: Shrink
): Promise<{ blob: Blob; mimeType: string }> {
  const blob = await read(attachment.url as string).catch((error: Error) => {
    throw new Error(`Couldn't read ${attachment.name}: ${error.message}.`);
  });
  const { mimeType } = attachment;
  if (attachment.kind !== 'image' || blob.size <= IMAGE_LIMIT) return { blob, mimeType };
  const image = { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
  const smaller = await fit(image).catch(() => image);
  return {
    blob: new Blob([smaller.bytes as Uint8Array<ArrayBuffer>], { type: smaller.mimeType }),
    mimeType: smaller.mimeType,
  };
}

async function kept(attachment: Attachment, stored: Stored): Promise<StoredImage | undefined> {
  const match = REF.exec(attachment.id);
  if (!match) return undefined;
  const [, entry, message, part] = match.map(Number) as number[];
  const found = await stored({ entry, message, part } as ImageRef);
  if (found.data === null)
    throw new Error(`Couldn't find ${attachment.name} again; attach it again.`);
  return found;
}

async function written(base: Base, text: string, carry: Carry): Promise<SendAttachment> {
  const size = textBytes(text);
  if (size <= INLINE_LIMIT && carry.inline + size <= INLINE_TOTAL) {
    carry.all += size;
    carry.inline += size;
    return { ...base, text };
  }
  if (base.path !== undefined) return base;
  return carried({ ...base, kind: 'file' }, new Blob([text], { type: base.mimeType }), carry);
}

async function resolved(
  attachment: Attachment,
  read: Read,
  fit: Shrink,
  stored: Stored,
  carry: Carry
): Promise<SendAttachment> {
  const kind = attachment.kind as AttachmentKind;
  const base = {
    name: attachment.name,
    kind,
    mimeType: attachment.mimeType,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  };
  const found = await kept(attachment, stored);
  if (found?.data) {
    const bytes = fromBase64(found.data) as Uint8Array<ArrayBuffer>;
    return carried({ ...base, mimeType: found.mimeType }, new Blob([bytes]), carry);
  }
  if (kind === 'text' && attachment.text !== undefined)
    return written(base, attachment.text, carry);
  if (attachment.url) {
    const { blob, mimeType } = await fitted(attachment, read, fit);
    return carried({ ...base, mimeType }, blob, carry);
  }
  if (attachment.path !== undefined) return base;
  throw new Error(`Couldn't read ${attachment.name}; attach it again.`);
}

export async function sendAttachments(
  attachments: readonly Attachment[] = [],
  read: Read = readUrl,
  fit: Shrink = shrink,
  stored: Stored = async () => ({ data: null, mimeType: null }),
  stage?: Stage
): Promise<SendAttachment[]> {
  const out: SendAttachment[] = [];
  const carry: Carry = { stage, inline: 0, all: 0 };
  for (const attachment of attachments) {
    if (attachment.error || !KINDS.has(attachment.kind)) continue;
    out.push(await resolved(attachment, read, fit, stored, carry));
  }
  return out;
}

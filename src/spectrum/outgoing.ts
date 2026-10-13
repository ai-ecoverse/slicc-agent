import type { Attachment } from '@ai-ecoverse/slicc-spectrum/ui';
import {
  type AttachmentKind,
  limitOf,
  REF,
  type SendAttachment,
  TOGETHER,
  TOTAL_LIMIT,
  tooLarge,
} from '../attachments.ts';
import { base64, type Shrink, shrink } from '../images/index.ts';
import type { ImageRef, StoredImage } from '../services.ts';

export type Read = (url: string) => Promise<Uint8Array>;

export type Stored = (ref: ImageRef) => Promise<StoredImage>;

export const readUrl: Read = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`status ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const KINDS = new Set<string>(['image', 'text', 'file']);

async function bytesOf(
  attachment: Attachment,
  read: Read,
  fit: Shrink
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const bytes = await read(attachment.url as string).catch((error: Error) => {
    throw new Error(`Couldn't read ${attachment.name}: ${error.message}.`);
  });
  const kind = attachment.kind as AttachmentKind;
  const image = { bytes, mimeType: attachment.mimeType };
  const fitted =
    kind === 'image' && bytes.length > limitOf(kind) ? await fit(image).catch(() => image) : image;
  if (fitted.bytes.length > limitOf(kind)) throw new Error(tooLarge(attachment.name, kind));
  return fitted;
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

async function resolved(
  attachment: Attachment,
  read: Read,
  fit: Shrink,
  stored: Stored
): Promise<SendAttachment> {
  const kind = attachment.kind as AttachmentKind;
  const base = {
    name: attachment.name,
    kind,
    mimeType: attachment.mimeType,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  };
  const found = await kept(attachment, stored);
  if (found?.data) return { ...base, mimeType: found.mimeType, data: found.data };
  if (kind === 'text' && attachment.text !== undefined) return { ...base, text: attachment.text };
  if (attachment.url) {
    const { bytes, mimeType } = await bytesOf(attachment, read, fit);
    return { ...base, mimeType, data: base64(bytes) };
  }
  if (attachment.path !== undefined) return base;
  throw new Error(`Couldn't read ${attachment.name}; attach it again.`);
}

export async function sendAttachments(
  attachments: readonly Attachment[] = [],
  read: Read = readUrl,
  fit: Shrink = shrink,
  stored: Stored = async () => ({ data: null, mimeType: null })
): Promise<SendAttachment[]> {
  const out: SendAttachment[] = [];
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.error || !KINDS.has(attachment.kind)) continue;
    const item = await resolved(attachment, read, fit, stored);
    total += (item.text?.length ?? 0) + ((item.data?.length ?? 0) * 3) / 4;
    if (total > TOTAL_LIMIT) throw new Error(TOGETHER);
    out.push(item);
  }
  return out;
}

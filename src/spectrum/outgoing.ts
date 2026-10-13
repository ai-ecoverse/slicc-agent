import type { Attachment } from '@ai-ecoverse/slicc-spectrum/ui';
import {
  type AttachmentKind,
  limitOf,
  type SendAttachment,
  TOGETHER,
  TOTAL_LIMIT,
  tooLarge,
} from '../attachments.ts';
import { base64, type Shrink, shrink } from '../images/index.ts';

export type Read = (url: string) => Promise<Uint8Array>;

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

async function resolved(attachment: Attachment, read: Read, fit: Shrink): Promise<SendAttachment> {
  const kind = attachment.kind as AttachmentKind;
  const base = {
    name: attachment.name,
    kind,
    mimeType: attachment.mimeType,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  };
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
  fit: Shrink = shrink
): Promise<SendAttachment[]> {
  const out: SendAttachment[] = [];
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.error || !KINDS.has(attachment.kind)) continue;
    const item = await resolved(attachment, read, fit);
    total += (item.text?.length ?? 0) + ((item.data?.length ?? 0) * 3) / 4;
    if (total > TOTAL_LIMIT) throw new Error(TOGETHER);
    out.push(item);
  }
  return out;
}

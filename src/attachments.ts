export type AttachmentKind = 'image' | 'text' | 'file';

export interface SendAttachment {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  data?: string;
  text?: string;
  path?: string;
}

export interface ShownAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  url?: string;
  text?: string;
  path?: string;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface Saver {
  sees: boolean;
  save?(name: string, bytes: Uint8Array): Promise<string>;
}

const MIB = 1024 * 1024;

export const IMAGE_LIMIT = 5 * MIB;
export const FILE_LIMIT = 8 * MIB;
export const TOTAL_LIMIT = 10 * MIB;

export const SEEN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const BLIND = "This model can't see images, so the image was saved as a file instead.";

export const TOGETHER = `These attachments add up to more than ${TOTAL_LIMIT / MIB} MiB; send them in separate messages.`;

export function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MiB`;
}

export function limitOf(kind: AttachmentKind): number {
  return kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT;
}

export function tooLarge(name: string, kind: AttachmentKind): string {
  return `${name} is larger than ${mib(limitOf(kind))}, so it can't be sent.`;
}

export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function decodedSize(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };

function escape(value: string): string {
  return value.replace(/[&"<>]/g, (char) => ESCAPES[char] as string);
}

function unescape(value: string): string {
  return value.replace(/&(amp|quot|lt|gt);/g, (_, name: string) =>
    name === 'amp' ? '&' : name === 'quot' ? '"' : name === 'lt' ? '<' : '>'
  );
}

interface Header {
  kind: AttachmentKind;
  name: string;
  type: string;
  path?: string;
  size?: number;
}

export function wrap(header: Header, body: string): string {
  const path = header.path === undefined ? '' : ` path="${escape(header.path)}"`;
  const size = header.size === undefined ? '' : ` size="${header.size}"`;
  return `<attachment kind="${header.kind}" name="${escape(header.name)}" type="${escape(header.type)}"${path}${size}>\n${body}\n</attachment>`;
}

const WRAPPED =
  /^<attachment kind="(image|text|file)" name="([^"]*)" type="([^"]*)"(?: path="([^"]*)")?(?: size="(\d+)")?>\n([\s\S]*)\n<\/attachment>$/;

function unwrap(text: string): (Header & { body: string }) | undefined {
  const match = WRAPPED.exec(text);
  if (!match) return undefined;
  const [, kind, name, type, path, size, body] = match as unknown as string[];
  return {
    kind: kind as AttachmentKind,
    name: unescape(name as string),
    type: unescape(type as string),
    ...(path === undefined ? {} : { path: unescape(path) }),
    ...(size === undefined ? {} : { size: Number(size) }),
    body: body as string,
  };
}

type Block = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  full?: { mimeType: string; size: number };
};

export const REF = /^ref:(\d+):(\d+):(\d+)$/;

function picture(base: Omit<ShownAttachment, 'size'>, block: Block, ref?: string): ShownAttachment {
  const url = block.data ? { url: `data:${block.mimeType};base64,${block.data}` } : {};
  if (!block.full) return { ...base, size: decodedSize(block.data ?? ''), ...url };
  return {
    ...base,
    ...(ref ? { id: ref } : {}),
    mimeType: block.full.mimeType,
    size: block.full.size,
    ...url,
  };
}

function shown(
  header: Header & { body: string },
  index: number,
  next?: Block,
  ref?: string
): ShownAttachment {
  const base = {
    id: `a${index}`,
    name: header.name,
    kind: header.kind,
    mimeType: header.type,
    ...(header.path === undefined ? {} : { path: header.path }),
  };
  if (header.kind === 'text')
    return { ...base, size: header.size ?? header.body.length, text: header.body };
  if (next) return picture(base, next, ref);
  return { ...base, size: header.size ?? 0 };
}

export function splitUser(
  content: unknown,
  prefix?: string
): { text: string; attachments: ShownAttachment[] } {
  if (typeof content === 'string') return { text: content, attachments: [] };
  const blocks = Array.isArray(content) ? (content as Block[]) : [];
  const attachments: ShownAttachment[] = [];
  let text = '';
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index] as Block;
    const header = block.type === 'text' ? unwrap(block.text ?? '') : undefined;
    const next = blocks[index + 1];
    const ref = (at: number) => (prefix ? `${prefix}:${at}` : undefined);
    if (header) {
      const image = header.kind === 'image' && next?.type === 'image' ? next : undefined;
      attachments.push(shown(header, attachments.length, image, ref(index + 1)));
      if (image) index++;
    } else if (block.type === 'text') text += block.text ?? '';
    else if (block.type === 'image' && (block.data || block.full))
      attachments.push(
        shown(
          { kind: 'image', name: 'image', type: String(block.mimeType), body: '' },
          attachments.length,
          block,
          ref(index)
        )
      );
  }
  return { text, attachments };
}

async function encoded(attachment: SendAttachment, data: string, saver: Saver): Promise<Part[]> {
  const size = decodedSize(data);
  if (size > limitOf(attachment.kind)) throw new Error(tooLarge(attachment.name, attachment.kind));
  const header = { kind: attachment.kind, name: attachment.name, type: attachment.mimeType };
  if (attachment.kind === 'image' && saver.sees && SEEN.has(attachment.mimeType))
    return [
      { type: 'text', text: wrap(header, '') },
      { type: 'image', data, mimeType: attachment.mimeType },
    ];
  if (!saver.save) throw new Error(`This agent can't save ${attachment.name} as a file.`);
  const path = await saver.save(attachment.name, fromBase64(data));
  const blind = attachment.kind === 'image' && !saver.sees ? ` ${BLIND}` : '';
  return [{ type: 'text', text: wrap({ ...header, path, size }, `Saved at ${path}.${blind}`) }];
}

async function partsOf(attachment: SendAttachment, saver: Saver): Promise<Part[]> {
  const header = {
    kind: attachment.kind,
    name: attachment.name,
    type: attachment.mimeType,
    ...(attachment.path === undefined ? {} : { path: attachment.path }),
  };
  if (attachment.kind === 'text' && attachment.text !== undefined) {
    if (textBytes(attachment.text) > FILE_LIMIT)
      throw new Error(tooLarge(attachment.name, attachment.kind));
    return [{ type: 'text', text: wrap(header, attachment.text) }];
  }
  if (attachment.data !== undefined) return encoded(attachment, attachment.data, saver);
  if (attachment.path !== undefined)
    return [{ type: 'text', text: wrap(header, `It is at ${attachment.path}.`) }];
  throw new Error(`${attachment.name} has nothing to send.`);
}

export async function userParts(
  text: string,
  attachments: readonly SendAttachment[],
  saver: Saver
): Promise<Part[]> {
  const total = attachments.reduce(
    (sum, item) => sum + textBytes(item.text ?? '') + decodedSize(item.data ?? ''),
    0
  );
  if (total > TOTAL_LIMIT) throw new Error(TOGETHER);
  const parts: Part[] = text ? [{ type: 'text', text }] : [];
  for (const attachment of attachments) parts.push(...(await partsOf(attachment, saver)));
  return parts;
}

export type AttachmentKind = 'image' | 'text' | 'file';

export interface SendAttachment {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  data?: string;
  text?: string;
  path?: string;
  upload?: string;
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
  staging?: { take(id: string): Promise<Blob | undefined>; drop(id: string): Promise<void> };
}

const MIB = 1024 * 1024;

export const IMAGE_LIMIT = 5 * MIB;
export const INLINE_LIMIT = 8 * MIB;
export const INLINE_TOTAL = 10 * MIB;
export const FILE_LIMIT = 100 * MIB;
export const TOTAL_LIMIT = 256 * MIB;

export const STAGED_DIR = '/.slicc/attachments';

export const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function stagedDir(serverId: string): string {
  return `${STAGED_DIR}/${serverId}`;
}

export const SEEN = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const BLIND = "This model can't see images, so the image was saved as a file instead.";

export const UNSHOWN =
  'The image was too large to show the model, so it was saved as a file instead.';

export function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MiB`;
}

export function together(limit: number): string {
  return `These attachments add up to more than ${mib(limit)}; send them in separate messages.`;
}

export function tooLarge(name: string, limit: number): string {
  return `${name} is larger than ${mib(limit)}, so it can't be sent.`;
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
  return value.replace(/\p{Cc}/gu, ' ').replace(/[&"<>]/g, (char) => ESCAPES[char] as string);
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

function savedText(attachment: SendAttachment, path: string, size: number, saver: Saver): Part {
  const header = { kind: attachment.kind, name: attachment.name, type: attachment.mimeType };
  const image = attachment.kind === 'image';
  const note = !image
    ? ''
    : !saver.sees
      ? ` ${BLIND}`
      : SEEN.has(attachment.mimeType)
        ? ` ${UNSHOWN}`
        : '';
  return {
    type: 'text',
    text: wrap({ ...header, path, size }, `Saved at ${escape(path)}.${note}`),
  };
}

function shownImage(attachment: SendAttachment, size: number, saver: Saver): boolean {
  return (
    attachment.kind === 'image' &&
    saver.sees &&
    SEEN.has(attachment.mimeType) &&
    size <= IMAGE_LIMIT
  );
}

interface Plan {
  attachment: SendAttachment;
  size: number;
  blob?: Blob;
}

function saving(attachment: SendAttachment, saver: Saver): void {
  if (!saver.save) throw new Error(`This agent can't save ${attachment.name} as a file.`);
}

async function planned(attachment: SendAttachment, saver: Saver): Promise<Plan> {
  if (attachment.kind === 'text' && attachment.text !== undefined) {
    const size = textBytes(attachment.text);
    if (size > INLINE_LIMIT) throw new Error(tooLarge(attachment.name, INLINE_LIMIT));
    return { attachment, size };
  }
  if (attachment.data !== undefined) {
    const size = decodedSize(attachment.data);
    if (size > INLINE_LIMIT) throw new Error(tooLarge(attachment.name, INLINE_LIMIT));
    if (!shownImage(attachment, size, saver)) saving(attachment, saver);
    return { attachment, size };
  }
  if (attachment.upload !== undefined) {
    const id = attachment.upload;
    const blob = STAGED_ID.test(id) ? await saver.staging?.take(id) : undefined;
    if (!blob) throw new Error(`Couldn't find ${attachment.name} again; attach it again.`);
    if (blob.size > FILE_LIMIT) throw new Error(tooLarge(attachment.name, FILE_LIMIT));
    saving(attachment, saver);
    return { attachment, size: blob.size, blob };
  }
  if (attachment.path !== undefined) return { attachment, size: 0 };
  throw new Error(`${attachment.name} has nothing to send.`);
}

async function partsOf({ attachment, size, blob }: Plan, saver: Saver): Promise<Part[]> {
  const base = { kind: attachment.kind, name: attachment.name, type: attachment.mimeType };
  const header = { ...base, ...(attachment.path === undefined ? {} : { path: attachment.path }) };
  if (attachment.kind === 'text' && attachment.text !== undefined)
    return [{ type: 'text', text: wrap(header, attachment.text) }];
  const save = saver.save as NonNullable<Saver['save']>;
  if (attachment.data !== undefined) {
    if (shownImage(attachment, size, saver))
      return [
        { type: 'text', text: wrap(base, '') },
        { type: 'image', data: attachment.data, mimeType: attachment.mimeType },
      ];
    const path = await save(attachment.name, fromBase64(attachment.data));
    return [savedText(attachment, path, size, saver)];
  }
  if (blob) {
    const path = await save(attachment.name, new Uint8Array(await blob.arrayBuffer()));
    return [savedText(attachment, path, size, saver)];
  }
  return [{ type: 'text', text: wrap(header, `It is at ${escape(attachment.path as string)}.`) }];
}

export async function userParts(
  text: string,
  attachments: readonly SendAttachment[],
  saver: Saver
): Promise<Part[]> {
  try {
    const inline = attachments.reduce(
      (sum, item) => sum + textBytes(item.text ?? '') + decodedSize(item.data ?? ''),
      0
    );
    if (inline > INLINE_TOTAL) throw new Error(together(INLINE_TOTAL));
    const plans: Plan[] = [];
    for (const attachment of attachments) plans.push(await planned(attachment, saver));
    if (plans.reduce((sum, plan) => sum + plan.size, 0) > TOTAL_LIMIT)
      throw new Error(together(TOTAL_LIMIT));
    const parts: Part[] = text ? [{ type: 'text', text }] : [];
    for (const plan of plans) parts.push(...(await partsOf(plan, saver)));
    return parts;
  } finally {
    const ids = attachments.flatMap((item) => (item.upload === undefined ? [] : [item.upload]));
    await Promise.all(ids.map((id) => saver.staging?.drop(id)));
  }
}

import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';
import { decodedSize, fromBase64 } from './attachments.ts';
import { base64 } from './images/index.ts';

export const KEEP = 48 * 1024;
export const THUMB_EDGE = 256;

export interface Picture {
  data: string;
  mimeType: string;
}

export type Thumbnail = (image: Picture) => Promise<Picture | undefined>;

export interface FullImage {
  mimeType: string;
  size: number;
}

type Part = { type?: string; data?: string; mimeType?: string; full?: FullImage };
type Message = { content?: unknown };
type Item = { id?: number; content?: unknown };

type Canvas = {
  getContext(kind: '2d'): { drawImage(...args: unknown[]): void } | null;
  convertToBlob(options: { type: string; quality?: number }): Promise<Blob>;
};

type Scope = {
  createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close(): void }>;
  OffscreenCanvas?: new (width: number, height: number) => Canvas;
};

export const thumbnail: Thumbnail = async (image) => {
  const scope = globalThis as unknown as Scope;
  if (!scope.createImageBitmap || !scope.OffscreenCanvas) return undefined;
  const bitmap = await scope.createImageBitmap(
    new Blob([fromBase64(image.data) as BlobPart], { type: image.mimeType })
  );
  for (const edge of [THUMB_EDGE, THUMB_EDGE / 2]) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new scope.OffscreenCanvas(width, height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const data = base64(new Uint8Array(await blob.arrayBuffer()));
    if (data.length <= KEEP) {
      bitmap.close();
      return { data, mimeType: 'image/jpeg' };
    }
  }
  bitmap.close();
  return undefined;
};

export interface Slimmer {
  slim(view: ConversationView): ConversationView;
  dispose(): void;
}

export function slimmer(make: Thumbnail, ready: () => void): Slimmer {
  const made = new Map<string, Picture | null>();
  let closed = false;
  const thumb = (key: string, part: Part): Part => {
    const full = { mimeType: String(part.mimeType), size: decodedSize(part.data as string) };
    if (!made.has(key)) {
      made.set(key, null);
      void make({ data: part.data as string, mimeType: full.mimeType })
        .catch(() => undefined)
        .then((picture) => {
          if (!picture || closed) return;
          made.set(key, picture);
          ready();
        });
    }
    const picture = made.get(key);
    return picture
      ? { type: 'image', data: picture.data, mimeType: picture.mimeType, full }
      : { type: 'image', data: '', mimeType: full.mimeType, full };
  };
  const content = (key: string, value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    let changed = false;
    const out = (value as Part[]).map((part, index) => {
      if (part.type !== 'image' || (part.data?.length ?? 0) <= KEEP) return part;
      changed = true;
      return thumb(`${key}:${index}`, part);
    });
    return changed ? out : value;
  };
  const entry = (record: EntryRecord): EntryRecord => {
    if (!record.model?.length) return record;
    let changed = false;
    const model = (record.model as readonly Message[]).map((message, at) => {
      const next = content(`${record.id}:${at}`, message.content);
      if (next === message.content) return message;
      changed = true;
      return { ...message, content: next };
    });
    return changed ? ({ ...record, model } as unknown as EntryRecord) : record;
  };
  const inbox = (doc: { items?: Item[] } | undefined) => {
    if (!doc?.items) return doc;
    let changed = false;
    const items = doc.items.map((item) => {
      const next = content(`q${item.id}:0`, item.content);
      if (next === item.content) return item;
      changed = true;
      return { ...item, content: next };
    });
    return changed ? { ...doc, items } : doc;
  };
  return {
    slim(view) {
      const entries = view.entries.map(entry);
      const queue = view.docs['pi.inbox'] as { items?: Item[] } | undefined;
      const slimmed = inbox(queue);
      const same = slimmed === queue && entries.every((item, at) => item === view.entries[at]);
      if (same) return view;
      return {
        ...view,
        entries,
        docs: slimmed === queue ? view.docs : { ...view.docs, 'pi.inbox': slimmed as never },
      };
    },
    dispose() {
      closed = true;
      made.clear();
    },
  };
}

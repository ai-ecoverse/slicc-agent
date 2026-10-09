import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable';

export const MAX_WIDTH = 1600;
export const MAX_BASE64 = 1024 * 1024;

export type Image = { bytes: Uint8Array; mimeType: string };
export type Shrink = (image: Image) => Promise<Image>;

const SIGNATURES: [string, number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
];

export function mimeOf(bytes: Uint8Array): string | undefined {
  for (const [mime, signature] of SIGNATURES)
    if (signature.every((byte, index) => bytes[index] === byte)) return mime;
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  return riff === 'RIFF' && webp === 'WEBP' ? 'image/webp' : undefined;
}

export function base64(bytes: Uint8Array): string {
  let text = '';
  for (let start = 0; start < bytes.length; start += 0x8000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(text);
}

export const shrink: Shrink = async (image) => {
  const scope = globalThis as unknown as {
    createImageBitmap?: (blob: Blob) => Promise<{ width: number; height: number; close(): void }>;
    OffscreenCanvas?: new (
      width: number,
      height: number
    ) => {
      getContext(
        kind: '2d'
      ): { drawImage(source: unknown, x: number, y: number, w: number, h: number): void } | null;
      convertToBlob(options: { type: string; quality?: number }): Promise<Blob>;
    };
  };
  if (!scope.createImageBitmap || !scope.OffscreenCanvas) return image;
  const bitmap = await scope.createImageBitmap(
    new Blob([image.bytes as BlobPart], { type: image.mimeType })
  );
  const tooWide = bitmap.width > MAX_WIDTH;
  const tooBig = base64(image.bytes).length > MAX_BASE64;
  if (!tooWide && !tooBig) {
    bitmap.close();
    return image;
  }
  const scale = tooWide ? MAX_WIDTH / bitmap.width : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new scope.OffscreenCanvas(width, height);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: 'image/png' });
  const blob =
    png.size * 1.4 > MAX_BASE64
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      : png;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
};

type Result = Awaited<ReturnType<ToolRegistration['execute']>>;

function unsupportedImage(result: Result): boolean {
  const diagnostics = (result as { diagnostics?: { code?: string }[] }).diagnostics ?? [];
  return diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_image');
}

function refuse(text: string): Result {
  return { content: [{ type: 'text', text }], isError: true } as Result;
}

export function imageReads(read: ToolRegistration, fit: Shrink = shrink): Extension {
  return defineExtension({
    name: 'slicc-images',
    wraps: [
      wrapTool(read, (inner) => ({
        ...inner,
        async execute(args, api, context: Context) {
          const result = await inner.execute(args, api, context);
          if (!unsupportedImage(result) || !api.env) return result;
          const path = String((args as { path: unknown }).path);
          const read = await api.env.readBinaryFile(path, context);
          const mimeType = read.ok ? mimeOf(read.value) : undefined;
          if (!read.ok || !mimeType) return result;
          const image = await fit({ bytes: read.value, mimeType }).catch(() => ({
            bytes: read.value,
            mimeType,
          }));
          const data = base64(image.bytes);
          if (data.length > MAX_BASE64)
            return refuse(
              `${path} is too large to read as an image (${image.bytes.length} bytes after fitting it to ${MAX_WIDTH} px). Take a smaller screenshot, for example with --max-width ${MAX_WIDTH}.`
            );
          return {
            content: [
              { type: 'text', text: `${path} (${image.mimeType}, ${image.bytes.length} bytes)` },
              { type: 'image', data, mimeType: image.mimeType },
            ],
          } as Result;
        },
      })),
    ],
  });
}

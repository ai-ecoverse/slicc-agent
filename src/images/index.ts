import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { fitted, MAX_BASE64, MAX_WIDTH, mimeOf, type Shrink, shrink } from './fit.ts';
import { imageMarkers } from './markers.ts';

export { base64, type Image, MAX_BASE64, MAX_WIDTH, mimeOf, type Shrink, shrink } from './fit.ts';

type Result = Awaited<ReturnType<ToolRegistration['execute']>>;

function unsupportedImage(result: Result): boolean {
  const diagnostics = (result as { diagnostics?: { code?: string }[] }).diagnostics ?? [];
  return diagnostics.some((diagnostic) => diagnostic.code === 'unsupported_image');
}

function refuse(text: string): Result {
  return { output: [{ type: 'text', text }], isError: true } as Result;
}

const bash = (CodingTools.tools as readonly ToolRegistration[]).find(
  (tool) => tool.name === 'bash'
) as ToolRegistration;

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
          const { image, data } = await fitted({ bytes: read.value, mimeType }, fit);
          if (data.length > MAX_BASE64)
            return refuse(
              `${path} is too large to read as an image (${image.bytes.length} bytes after fitting it to ${MAX_WIDTH} px). Take a smaller screenshot, for example with --max-width ${MAX_WIDTH}.`
            );
          return {
            output: [
              { type: 'text', text: `${path} (${image.mimeType}, ${image.bytes.length} bytes)` },
              { type: 'image', data, mimeType: image.mimeType },
            ],
          } as Result;
        },
      })),
      imageMarkers(bash, fit),
    ],
  });
}

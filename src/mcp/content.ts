import type { Context } from '@earendil-works/chord';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { type CallToolResult, type ContentBlock, toLlmContent } from '@earendil-works/pi-mcp';

export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;
export const READ_MCP_RESOURCE = 'read_mcp_resource';

export type Content = TextContent | ImageContent;

export type Saver = (data: string | Uint8Array, extension: string) => Promise<string>;

export interface Truncation {
  content: string;
  truncated: boolean;
  totalBytes: number;
  totalLines: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateMiddle(content: string, maxBytes: number): Truncation {
  const bytes = new TextEncoder().encode(content);
  const totalLines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;
  if (bytes.length <= maxBytes)
    return { content, truncated: false, totalBytes: bytes.length, totalLines };
  const boundary = (index: number) =>
    index >= bytes.length || ((bytes[index] as number) & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !boundary(headEnd)) headEnd--;
  let tailStart = bytes.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < bytes.length && !boundary(tailStart)) tailStart++;
  const decoder = new TextDecoder();
  const head = decoder.decode(bytes.subarray(0, headEnd));
  const tail = decoder.decode(bytes.subarray(tailStart));
  const removed = Array.from(decoder.decode(bytes.subarray(headEnd, tailStart))).length;
  return {
    content: `${head}…${removed} chars truncated…${tail}`,
    truncated: true,
    totalBytes: bytes.length,
    totalLines,
  };
}

function textOf(content: readonly Content[]): string {
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

export async function limitContent(
  content: Content[],
  save: Saver
): Promise<{ content: Content[]; fullOutputPath?: string }> {
  const combined = textOf(content);
  const cut = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
  if (!cut.truncated) return { content };
  let fullOutputPath: string | undefined;
  let where: string;
  try {
    fullOutputPath = await save(combined, '.txt');
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const tokens = Math.ceil(cut.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${cut.totalLines}\n\n${cut.content}\n\n${where}`;
  return {
    content: [{ type: 'text', text }, ...content.filter((block) => block.type === 'image')],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}

function extensionOf(uri: string): string {
  const path = URL.canParse(uri) ? new URL(uri).pathname : uri;
  return /\.[A-Za-z0-9]{1,8}$/.exec(path)?.[0] ?? '.bin';
}

function isTextMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = (mimeType.split(';', 1)[0] as string).trim().toLowerCase();
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  );
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
  return out;
}

async function blockContent(
  server: string,
  block: ContentBlock,
  save: Saver,
  readable: boolean
): Promise<Content[]> {
  if (block.type === 'resource_link') {
    const details = [
      block.mimeType,
      block.size === undefined ? undefined : formatSize(block.size),
    ].filter(Boolean);
    const read = readable ? `. Read it with ${READ_MCP_RESOURCE} (server "${server}")` : '';
    const description = block.description ? `: ${block.description}` : '';
    return [
      {
        type: 'text',
        text: `[Resource ${block.uri} "${block.title ?? block.name}"${details.length ? ` (${details.join(', ')})` : ''}${description}${read}]`,
      },
    ];
  }
  if (
    block.type === 'resource' &&
    'blob' in block.resource &&
    !block.resource.mimeType?.startsWith('image/')
  ) {
    const { uri, mimeType, blob } = block.resource;
    const data = decode(blob);
    if (isTextMime(mimeType)) return [{ type: 'text', text: new TextDecoder().decode(data) }];
    const kind = `${mimeType ?? 'unknown type'}, ${formatSize(data.length)}`;
    try {
      const path = await save(data, extensionOf(uri));
      return [{ type: 'text', text: `[Binary resource ${uri} (${kind}) saved to ${path}]` }];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        { type: 'text', text: `[Binary resource ${uri} (${kind}) could not be saved: ${reason}]` },
      ];
    }
  }
  return toLlmContent({ content: [block] }) as Content[];
}

export async function modelContent(
  server: string,
  blocks: readonly ContentBlock[],
  save: Saver,
  readable = false
): Promise<Content[]> {
  const parts = await Promise.all(
    blocks.map((block) => blockContent(server, block, save, readable))
  );
  return parts.flat();
}

export async function convertResult(
  server: string,
  tool: string,
  result: CallToolResult,
  save: Saver,
  readable = false
): Promise<{ content: Content[]; isError: boolean; fullOutputPath?: string }> {
  const converted =
    result.content.length > 0
      ? await modelContent(server, result.content, save, readable)
      : (toLlmContent(result) as Content[]);
  if (result.isError && textOf(converted) === '')
    converted.push({ type: 'text', text: `MCP tool ${server}/${tool} returned an error` });
  const limited = await limitContent(converted, save);
  return { ...limited, isError: result.isError === true };
}

export function scriptResult(result: CallToolResult): Record<string, unknown> {
  const { _meta: _ignored, ...rest } = result as CallToolResult & { _meta?: unknown };
  return rest;
}

export function spiller(
  write: (path: string, data: string | Uint8Array, context: Context) => Promise<boolean>,
  id: () => string,
  context: Context
): Saver {
  return async (data, extension) => {
    const path = `/tmp/slicc-mcp-${id().replace(/[^\w-]/g, '_')}${extension}`;
    if (!(await write(path, data, context))) throw new Error(`could not write ${path}`);
    return path;
  };
}

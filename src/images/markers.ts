import type { Context } from '@earendil-works/chord';
import { boundOutput, OutputBuffer, type OutputLimits } from '@earendil-works/chord/output';
import { type ToolRegistration, type Wrap, wrapTool } from '@earendil-works/pi-durable';
import type { ExecutionEnv, ShellExecOptions } from '@earendil-works/pi-durable/env';

import { fitted, MAX_BASE64, MAX_WIDTH, mimeOf, type Shrink } from './fit.ts';

export const MAX_IMAGES = 4;
export const MAX_MARKER = 4096;

type Api = Parameters<ToolRegistration['execute']>[1];
type Result = Awaited<ReturnType<ToolRegistration['execute']>>;
type Image = { type: 'image'; data: string; mimeType: string };
type Shown = { text: string; image?: Image };

const MARKER = /^<img:(.+)>$/;

export class Markers {
  readonly found: string[] = [];
  #line = '';
  #over = false;

  push(text: string): void {
    let start = 0;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', start)) {
      this.#add(text.slice(start, at));
      this.#close();
      start = at + 1;
    }
    this.#add(text.slice(start));
  }

  skip(): void {
    this.#line = '';
    this.#over = true;
  }

  end(): void {
    this.#close();
  }

  #add(part: string): void {
    if (this.#over) return;
    if (this.#line.length + part.length > MAX_MARKER) this.skip();
    else this.#line += part;
  }

  #close(): void {
    const line = this.#line.replace(/\r$/, '');
    if (!this.#over && MARKER.test(line)) this.found.push(line);
    this.#line = '';
    this.#over = false;
  }
}

export function pathOf(marker: string): string {
  return (MARKER.exec(marker) as RegExpExecArray)[1] as string;
}

function watched(env: ExecutionEnv, markers: Markers): ExecutionEnv {
  const exec: ExecutionEnv['exec'] = (command, options, context) => {
    const onOutput: NonNullable<ShellExecOptions['onOutput']> = (text, at, info) => {
      if (info.skipped) markers.skip();
      if (info.stream === 'stdout') markers.push(text);
      options?.onOutput?.(text, at, info);
    };
    return env.exec(command, { ...options, onOutput }, context);
  };
  return new Proxy(env, {
    get(target, key) {
      if (key === 'exec') return exec;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export async function shown(
  env: ExecutionEnv,
  path: string,
  fit: Shrink,
  context: Context
): Promise<Shown> {
  if (!path.startsWith('/'))
    return { text: `${path} is not an absolute path, so it was not read.` };
  const read = await env.readBinaryFile(path, context);
  if (!read.ok) return { text: `${path} could not be read (${read.error.code}).` };
  const mimeType = mimeOf(read.value);
  if (!mimeType) return { text: `${path} is not a PNG, JPEG, GIF or WebP image.` };
  const { image, data } = await fitted({ bytes: read.value, mimeType }, fit);
  if (data.length > MAX_BASE64)
    return {
      text: `${path} is too large to show as an image (${image.bytes.length} bytes after fitting it to ${MAX_WIDTH} px).`,
    };
  return {
    text: `${path} (${image.mimeType}, ${image.bytes.length} bytes)`,
    image: { type: 'image', data, mimeType: image.mimeType },
  };
}

export function placed(text: string, found: readonly string[], lines: readonly string[]): string {
  const rows = text.split('\n');
  let next = found.length - 1;
  for (let row = rows.length - 1; row >= 0 && next >= 0; row--) {
    if ((rows[row] as string).replace(/\r$/, '') !== found[next]) continue;
    rows[row] = lines[next] as string;
    next--;
  }
  const body = rows.join('\n');
  if (next < 0) return body;
  const gap = body === '' || body.endsWith('\n') ? '' : '\n';
  return `${body}${gap}${lines.slice(0, next + 1).join('\n')}\n`;
}

async function images(api: Api, found: readonly string[], fit: Shrink, context: Context) {
  const all: Shown[] = [];
  for (const [at, marker] of found.entries()) {
    const path = pathOf(marker);
    all.push(
      at < MAX_IMAGES
        ? await shown(api.env as ExecutionEnv, path, fit, context)
        : { text: `${path} was not shown: a command shows at most ${MAX_IMAGES} images.` }
    );
  }
  return all;
}

type Shadow = { buffer: OutputBuffer; limits: OutputLimits };

function bounded(text: string, shadow: Shadow | undefined) {
  if (!shadow) return { text, diagnostics: [] };
  shadow.buffer.end();
  const before = shadow.buffer.snapshot();
  const slice = boundOutput(text, shadow.limits);
  const bytes = before.droppedBytes + slice.droppedBytes;
  const lines = before.droppedLines + slice.droppedLines;
  if (!bytes) return { text, diagnostics: [] };
  return {
    text: slice.text,
    diagnostics: [
      {
        severity: 'warn' as const,
        code: 'truncated',
        message: `Output truncated to its end: ${lines} lines, ${bytes} bytes dropped`,
      },
    ],
  };
}

export function imageMarkers(bash: ToolRegistration, fit: Shrink): Wrap {
  return wrapTool(bash, (inner) => ({
    ...inner,
    async execute(args, api, context: Context) {
      if (!api.env) return inner.execute(args, api, context);
      const markers = new Markers();
      const window = api.outputWindow;
      const limits: OutputLimits | undefined = window && {
        maxBytes: window.maxBytes,
        maxLines: window.maxLines,
        retain: 'tail',
      };
      const shadow = limits && { limits, buffer: new OutputBuffer(limits) };
      const output: Api['output'] = (chunk, skipped) => {
        api.output(chunk, skipped);
        shadow?.buffer.push(chunk, skipped);
      };
      const env = watched(api.env, markers);
      const wrapped = Object.create(api, { env: { value: env }, output: { value: output } });
      const result = await inner.execute(args, wrapped, context);
      markers.end();
      if (!markers.found.length) return result;
      const all = await images(api, markers.found, fit, context);
      const { text, diagnostics } = bounded(
        placed(
          api.retainedOutput().text,
          markers.found,
          all.map((one) => one.text)
        ),
        shadow
      );
      const structured = result.structuredOutput;
      return {
        ...result,
        output: [{ type: 'text', text }, ...all.flatMap((one) => (one.image ? [one.image] : []))],
        diagnostics: [...(result.diagnostics ?? []), ...diagnostics],
        ...(structured && typeof structured === 'object'
          ? { structuredOutput: { ...structured, output: text } }
          : {}),
      } as Result;
    },
  }));
}

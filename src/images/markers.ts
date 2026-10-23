import type { Context } from '@earendil-works/chord';
import { boundOutput, OutputBuffer, type OutputLimits } from '@earendil-works/chord/output';
import { type ToolRegistration, type Wrap, wrapTool } from '@earendil-works/pi-durable';
import type { ExecutionEnv, ShellExecOptions } from '@earendil-works/pi-durable/env';

import { gatedRun } from '../guests/guard.ts';
import { fitted, MAX_BASE64, MAX_WIDTH, mimeOf, type Shrink } from './fit.ts';

export const MAX_IMAGES = 4;
export const MAX_MARKER = 4096;
export const DEFAULT_MAX_BYTES = 51200;

type Api = Parameters<ToolRegistration['execute']>[1];
type Result = Awaited<ReturnType<ToolRegistration['execute']>>;
type Image = { type: 'image'; data: string; mimeType: string };
type Shown = { text: string; image?: Image };

const MARKER = /^<img:(.+)>$/;
const LATER_REASON = `a command shows at most ${MAX_IMAGES} images.`;
const LATER = `was not shown: ${LATER_REASON}`;

export type Marker = { at: number; line: string };

export class Markers {
  readonly first: Marker[] = [];
  count = 0;
  #recent: Marker[] = [];
  #head = 0;
  #bytes = 0;
  #line = '';
  #over = false;

  readonly budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  get recent(): readonly Marker[] {
    return this.#recent.slice(this.#head);
  }

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
    if (!this.#over && MARKER.test(line)) this.#keep(line);
    this.#line = '';
    this.#over = false;
  }

  #keep(line: string): void {
    const at = this.count++;
    if (at < MAX_IMAGES) this.first.push({ at, line });
    this.#recent.push({ at, line });
    this.#bytes += line.length + 1;
    while (this.#bytes > this.budget) {
      this.#bytes -= (this.#recent[this.#head] as Marker).line.length + 1;
      this.#head++;
    }
    if (this.#head * 2 > this.#recent.length) {
      this.#recent = this.#recent.slice(this.#head);
      this.#head = 0;
    }
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

export function placed(
  text: string,
  markers: Pick<Markers, 'count' | 'first' | 'recent'>,
  lineOf: (marker: Marker) => string
): string {
  const rows = text.split('\n');
  const { recent } = markers;
  const done = new Set<number>();
  let next = recent.length - 1;
  for (let row = rows.length - 1; row >= 0 && next >= 0; row--) {
    const marker = recent[next] as Marker;
    if ((rows[row] as string).replace(/\r$/, '') !== marker.line) continue;
    rows[row] = lineOf(marker);
    done.add(marker.at);
    next--;
  }
  const missing = markers.first.filter((marker) => !done.has(marker.at)).map(lineOf);
  const shownLater = [...done].filter((at) => at >= MAX_IMAGES).length;
  const omitted = Math.max(0, markers.count - MAX_IMAGES) - shownLater;
  if (omitted > 0)
    missing.push(
      `${omitted} more image ${omitted === 1 ? 'line was' : 'lines were'} not shown: ${LATER_REASON}`
    );
  const body = rows.join('\n');
  if (!missing.length) return body;
  const gap = body === '' || body.endsWith('\n') ? '' : '\n';
  return `${body}${gap}${missing.join('\n')}\n`;
}

async function images(api: Api, first: readonly Marker[], fit: Shrink, context: Context) {
  const all: Shown[] = [];
  for (const marker of first)
    all.push(await shown(api.env as ExecutionEnv, pathOf(marker.line), fit, context));
  return all;
}

const GUESTED = 'was not read: a run a guest started shows no images from command output.';

function lineOf(all: readonly Shown[], gated: boolean) {
  return (marker: Marker) => {
    if (gated) return `${pathOf(marker.line)} ${GUESTED}`;
    return (all[marker.at] as Shown | undefined)?.text ?? `${pathOf(marker.line)} ${LATER}`;
  };
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
      const window = api.outputWindow;
      const markers = new Markers(window?.maxBytes ?? DEFAULT_MAX_BYTES);
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
      if (!markers.count) return result;
      const gated = await gatedRun(api, context);
      const all = gated ? [] : await images(api, markers.first, fit, context);
      const { text, diagnostics } = bounded(
        placed(api.retainedOutput().text, markers, lineOf(all, gated)),
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

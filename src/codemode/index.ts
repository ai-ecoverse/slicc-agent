import type { Context, JsonValue } from '@earendil-works/chord';
import { withAbortSignal } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import {
  type CodemodeError,
  type CodemodeJsonSchema,
  type CodemodeOutputItem,
  type CodemodeResult,
  CodemodeSandbox,
  type CodemodeSandboxOptions,
  type CodemodeTool,
  loadQuickJSWasm,
  parseCodemodeSource,
  renderDeclarations,
} from '@earendil-works/pi-codemode';
import {
  type Agent,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type JsonObject,
  type NestedToolExecutionResult,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { scrubItems } from '../secrets/scrub.ts';

export const CODEMODE = 'codemode';
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const CHARS_PER_TOKEN = 4;

export const CodemodeDoc = defineDoc<{ store: Record<string, JsonValue> }>({
  kind: 'slicc.codemode',
  version: 1,
  scope: 'conversation',
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ store: {} }),
});

export interface Sandbox {
  execute(
    code: string,
    options: { signal?: AbortSignal; store?: Record<string, unknown> }
  ): Promise<CodemodeResult>;
  close(): Promise<void>;
}

export type SandboxFactory = (options: CodemodeSandboxOptions) => Sandbox;

export interface CodemodeExtra {
  tools: CodemodeTool[];
  globals: CodemodeTool[];
}

export interface CodemodeOptions {
  sandbox: SandboxFactory;
  declared: readonly ToolRegistration[];
  extra?: (api: ToolExecutionApi, agent: Agent, context: Context) => Promise<CodemodeExtra>;
}

const INTRO = `Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` resolves to a string, or an object if the tool's declaration says so, and rejects with an Error on failure. Calls still running when the script ends are cancelled.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\``;

const GLOBALS = [
  'Globals:',
  '- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block.',
  '- `store(key, value)` and `load(key)` keep JSON values across codemode calls in this conversation.',
  '- `ALL_TOOLS` lists every tool scripts can call.',
].join('\n');

const DISCOVERY =
  '- `await searchTools(query, { limit?, namespace? })`, `await describeTool(name)`, `await describeNamespace(name)`: find unlisted tools, such as MCP tools.';

const BASH_OUTPUT: CodemodeJsonSchema = {
  type: 'object',
  properties: {
    output: { type: 'string' },
    exit_code: { type: 'number' },
    truncated: { type: 'boolean' },
    full_output_path: { type: 'string' },
  },
  required: ['output', 'exit_code'],
};

function scriptTool(tool: ToolRegistration): Omit<CodemodeTool, 'execute'> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as CodemodeJsonSchema,
    ...(tool.name === 'bash' ? { outputSchema: BASH_OUTPUT } : {}),
  };
}

export function codemodeDescription(
  declared: readonly ToolRegistration[],
  discovery = false
): string {
  const tools = declared
    .filter((tool) => tool.name !== CODEMODE)
    .map((tool) => ({ ...scriptTool(tool), execute: () => undefined }));
  const sections = [INTRO, discovery ? `${GLOBALS}\n${DISCOVERY}` : GLOBALS];
  if (tools.length) sections.push(`Nested tools:\n${renderDeclarations({ tools })}`);
  return sections.join('\n\n');
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function errorOf(result: NestedToolExecutionResult): string {
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
  return [textOf(result.structuredOutput), ...errors].filter(Boolean).join('\n');
}

interface ShellOutput {
  output: string;
  exitCode: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

function shellOutput(value: unknown): ShellOutput | undefined {
  const shell = value as Partial<ShellOutput> | undefined;
  return typeof shell?.output === 'string' && typeof shell.exitCode === 'number'
    ? (shell as ShellOutput)
    : undefined;
}

export async function callNested(
  name: string,
  args: unknown,
  api: ToolExecutionApi,
  context: Context
): Promise<unknown> {
  const result = await api.executeTool(name, (args ?? {}) as JsonObject, context);
  const shell = name === 'bash' ? shellOutput(result.structuredOutput) : undefined;
  if (shell)
    return {
      output: shell.output,
      exit_code: shell.exitCode,
      ...(shell.truncated ? { truncated: true } : {}),
      ...(shell.fullOutputPath ? { full_output_path: shell.fullOutputPath } : {}),
    };
  if (result.isError) throw new Error(errorOf(result) || `Tool "${name}" failed`);
  return textOf(result.structuredOutput);
}

function valueText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

export function formatOutput(output: readonly CodemodeOutputItem[]): CodemodeOutputItem[] {
  const total = output.filter((item) => item.type === 'text' && !item.console).length;
  const items: CodemodeOutputItem[] = [];
  const lines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === 'image') items.push(item);
    else if (item.console) lines.push(item.text);
    else {
      index++;
      items.push({
        type: 'text',
        text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text,
      });
    }
  }
  if (lines.length)
    items.push({ type: 'text', text: `<console_output>\n${lines.join('\n')}\n</console_output>` });
  return items;
}

export function joinText(items: readonly CodemodeOutputItem[]): CodemodeOutputItem[] {
  const joined: CodemodeOutputItem[] = [];
  for (const item of items) {
    const last = joined.at(-1);
    if (item.type === 'text' && last?.type === 'text') {
      const separator = last.text === '' || last.text.endsWith('\n') ? '' : '\n';
      joined[joined.length - 1] = { type: 'text', text: `${last.text}${separator}${item.text}` };
    } else joined.push(item);
  }
  return joined;
}

export function formatError(error: CodemodeError, calls: CodemodeResult['calls']): string {
  const heads: Record<string, string> = {
    timeout: `Script timed out: ${error.message}`,
    aborted: `Script aborted: ${error.message}`,
    sandbox: `Script sandbox failed: ${error.message}`,
  };
  const head =
    error.kind === 'script'
      ? (error.stack ?? `${error.name ?? 'Error'}: ${error.message}`)
      : heads[error.kind];
  const summary = calls.length
    ? `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(', ')}`
    : 'No tool calls were made.';
  return `${head}\n\n${summary}`;
}

export function truncate(
  items: readonly CodemodeOutputItem[],
  maxTokens: number
): { items: CodemodeOutputItem[]; full: string | null } {
  const text = items
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  const limit = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= limit) return { items: [...items], full: null };
  const half = Math.floor(limit / 2);
  const kept = `${text.slice(0, half)}\n\n[… ${text.length - 2 * half} characters omitted …]\n\n${text.slice(-half)}`;
  return {
    items: [{ type: 'text', text: kept }, ...items.filter((item) => item.type === 'image')],
    full: text,
  };
}

async function spill(api: ToolExecutionApi, text: string, context: Context): Promise<string> {
  const path = `/tmp/slicc-codemode-${api.callId.replace(/[^\w-]/g, '_')}.txt`;
  const written = await api.env?.writeFile(path, text, context);
  return written?.ok ? path : '';
}

async function saveStore(
  api: ToolExecutionApi,
  result: CodemodeResult,
  context: Context
): Promise<void> {
  if (!result.ok) return;
  const { set, delete: removed } = result.storeWrites;
  if (!Object.keys(set).length && !removed.length) return;
  await api.commit(async (tx) => {
    const doc = await tx.doc(CodemodeDoc, api.conversationId);
    for (const key of removed) delete doc.store[key];
    Object.assign(doc.store, set);
  }, context);
}

export function codemodeTool(options: CodemodeOptions): ToolRegistration {
  return defineTool({
    name: CODEMODE,
    description: codemodeDescription(options.declared, options.extra !== undefined),
    parameters: Type.Object({ code: Type.String({ description: 'Raw JavaScript source.' }) }),
    replay: 'unsafe',
    callers: ['model'],
    async execute({ code }, api, context) {
      const started = performance.now();
      const parsed = parseCodemodeSource(code);
      const agent = await api.agent(context);
      const callable = agent.tools.filter((tool) => tool.name !== CODEMODE);
      const tools: CodemodeTool[] = callable.map((tool) => ({
        ...scriptTool(tool),
        execute: (args, { signal }) =>
          callNested(tool.name, args, api, withAbortSignal(signal, context)),
      }));
      const extra = options.extra
        ? await options.extra(api, agent, context)
        : { tools: [], globals: [] };
      const replaced = new Set(extra.tools.map((tool) => tool.name));
      const scripted = [...tools.filter((tool) => !replaced.has(tool.name)), ...extra.tools];
      const saved = await api.snapshot(CodemodeDoc, api.conversationId, context);
      const sandbox = options.sandbox({
        tools: scripted,
        ...(extra.globals.length ? { globals: extra.globals } : {}),
        timeoutMs: parsed.options.timeoutMs ?? Number.POSITIVE_INFINITY,
        memoryLimitBytes: MEMORY_LIMIT_BYTES,
      });
      let result: CodemodeResult;
      try {
        result = await sandbox.execute(parsed.code, {
          signal: context.abortSignal as AbortSignal,
          store: { ...saved?.store },
        });
      } finally {
        await sandbox.close();
      }
      await saveStore(api, result, context);
      const output = [...result.output];
      if (result.ok && result.value !== undefined)
        output.push({ type: 'text', text: valueText(result.value) });
      const items = formatOutput(output);
      if (!result.ok)
        items.push({
          type: 'text',
          text: `Script error:\n${formatError(result.error, result.calls)}`,
        });
      const cut = truncate(
        await scrubItems(joinText(items)),
        parsed.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
      );
      const path = cut.full === null ? '' : await spill(api, cut.full, context);
      const note = path ? [{ type: 'text' as const, text: `Full output: ${path}` }] : [];
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const header = `${result.ok ? 'Script completed' : 'Script failed'}\nWall time ${seconds} seconds\nOutput:\n`;
      return {
        output: [{ type: 'text', text: header }, ...joinText([...cut.items, ...note])],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  }) as ToolRegistration;
}

export function codemodeExtension(tools: readonly ToolRegistration[]): Extension {
  return defineExtension({ name: 'slicc-codemode', tools });
}

export function disabledBySettings(text: string | undefined): boolean {
  if (!text) return false;
  try {
    const settings = JSON.parse(text) as { defaultTools?: unknown };
    return Array.isArray(settings.defaultTools) && settings.defaultTools.includes(`-${CODEMODE}`);
  } catch {
    return false;
  }
}

export type Fetcher = (url: string) => Promise<Response>;

export function wasmCandidates(from: URL): string[] {
  const out: string[] = [];
  let dir = new URL('.', from);
  for (;;) {
    out.push(new URL('node_modules/quickjs-wasi/quickjs.wasm', dir).href);
    if (dir.pathname === '/') return out;
    dir = new URL('..', dir);
  }
}

export async function locateWasm(
  fetcher: Fetcher,
  from: URL
): Promise<WebAssembly.Module | undefined> {
  for (const url of wasmCandidates(from)) {
    const response = await fetcher(url).catch(() => undefined);
    if (response?.ok) return WebAssembly.compile(await response.arrayBuffer());
  }
  return undefined;
}

export function sandboxFactory(
  wasm: () => Promise<WebAssembly.Module | undefined>,
  workerUrl?: string | URL
): SandboxFactory {
  let found: Promise<WebAssembly.Module | undefined> | undefined;
  return (options) => {
    found ??= wasm().catch(() => undefined);
    return new CodemodeSandbox({
      ...options,
      ...(workerUrl ? { workerUrl } : {}),
      wasm: found.then((module) => module ?? loadQuickJSWasm()),
    });
  };
}

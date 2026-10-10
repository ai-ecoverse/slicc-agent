import type { Context, JsonValue } from '@earendil-works/chord';
import {
  type CodemodeJsonSchema,
  type CodemodeTool,
  renderToolSample,
  toCodemodeIdentifier,
} from '@earendil-works/pi-codemode';
import {
  defineTool,
  type ToolExecutionApi,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { McpRequestOptions, Tool as McpTool } from '@earendil-works/pi-mcp';
import type { McpExposure } from './config.ts';
import { errorMessage, type McpServerConnection } from './connection.ts';
import {
  type Content,
  convertResult,
  limitContent,
  modelContent,
  READ_MCP_RESOURCE,
  type Saver,
  scriptResult,
  spiller,
} from './content.ts';
import { scrub } from './credentials.ts';

export const LIST_MCP_RESOURCES = 'list_mcp_resources';
export const LIST_MCP_RESOURCE_TEMPLATES = 'list_mcp_resource_templates';
export { READ_MCP_RESOURCE };

export interface McpToolEntry {
  server: string;
  name: string;
  exposure: McpExposure;
  tool: McpTool;
  connection: McpServerConnection;
}

export type McpDetails = { server: string; tool: string; fullOutputPath?: string };

function parametersOf(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = schema;
  return {
    ...rest,
    type: rest.type ?? 'object',
    ...(rest.properties === undefined ? { properties: {} } : {}),
  };
}

export function resultSchema(structured: Record<string, unknown> | undefined): CodemodeJsonSchema {
  return {
    type: 'object',
    properties: {
      content: { type: 'array', items: { type: 'object' } },
      ...(structured ? { structuredContent: structured } : {}),
      isError: { type: 'boolean' },
    },
    required: ['content'],
  };
}

function describe(entry: McpToolEntry): string {
  const title = entry.tool.title ?? entry.tool.annotations?.title;
  return (
    entry.tool.description?.trim() ||
    title ||
    `MCP tool ${entry.tool.name} from server ${entry.server}`
  );
}

function signalOf(context: Context): AbortSignal | undefined {
  return context.abortSignal as AbortSignal | undefined;
}

export function apiSaver(api: ToolExecutionApi, prefix: string, context: Context): Saver {
  let counter = 0;
  return spiller(
    async (path, data, using) => (await api.env?.writeFile(path, data, using))?.ok === true,
    () => `${api.callId}-${prefix}${++counter}`,
    context
  );
}

function progressText(progress: { progress: number; total?: number; message?: string }): string {
  const total = progress.total === undefined ? '' : `/${progress.total}`;
  return progress.message ?? `Progress ${progress.progress}${total}`;
}

function failure(entry: { connection: McpServerConnection }, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(scrub(message, entry.connection.secrets));
}

export function directTool(entry: McpToolEntry, readable: () => boolean): ToolRegistration {
  return defineTool({
    name: entry.name,
    description: describe(entry),
    parameters: parametersOf(entry.tool.inputSchema) as never,
    replay: 'unsafe',
    async execute(args, api, context) {
      const save = apiSaver(api, '', context);
      const options: McpRequestOptions = {
        timeoutMs: entry.connection.timeoutMs,
        onProgress: (progress) => api.output(`${progressText(progress)}\n`),
      };
      const signal = signalOf(context);
      if (signal) options.signal = signal;
      const result = await entry.connection
        .callTool(entry.tool.name, args as Record<string, unknown>, options)
        .catch((error) => failure(entry, error));
      const converted = await convertResult(
        entry.server,
        entry.tool.name,
        result,
        save,
        readable()
      );
      const details: McpDetails = {
        server: entry.server,
        tool: entry.tool.name,
        ...(converted.fullOutputPath ? { fullOutputPath: converted.fullOutputPath } : {}),
      };
      return {
        content: converted.content,
        details: details as JsonValue,
        ...(converted.isError ? { isError: true } : {}),
      };
    },
  }) as ToolRegistration;
}

export function scriptTool(entry: McpToolEntry, signal: AbortSignal | undefined): CodemodeTool {
  const inputSchema = parametersOf(entry.tool.inputSchema);
  const outputSchema = resultSchema(entry.tool.outputSchema as Record<string, unknown> | undefined);
  return {
    name: entry.name,
    description: describe(entry),
    inputSchema,
    outputSchema,
    async execute(args, { signal: own }) {
      const combined = signal ? AbortSignal.any([own, signal]) : own;
      const result = await entry.connection
        .callTool(entry.tool.name, (args ?? {}) as Record<string, unknown>, {
          signal: combined,
          timeoutMs: entry.connection.timeoutMs,
        })
        .catch((error) => failure(entry, error));
      return scriptResult(result);
    },
  };
}

export interface ResourceServer {
  name: string;
  connection: McpServerConnection;
}

function stringArgument(params: unknown, key: string): string | undefined {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value.trim() || undefined;
}

function listed(server: string, item: object): Record<string, unknown> {
  const { _meta, icons: _icons, ...rest } = item as Record<string, unknown>;
  return { server, ...rest };
}

const stringProperty = (description: string) => ({ type: 'string', description });
const LIST_PARAMETERS = {
  type: 'object',
  properties: {
    server: stringProperty('MCP server name. Omit to list every server with resources.'),
    cursor: stringProperty(
      'Opaque cursor from a previous call with the same server; omit for the first page.'
    ),
  },
  additionalProperties: false,
};
const READ_PARAMETERS = {
  type: 'object',
  properties: {
    server: stringProperty(
      "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."
    ),
    uri: stringProperty(
      'Resource URI to read. Must be one of the URIs returned by list_mcp_resources.'
    ),
  },
  required: ['server', 'uri'],
  additionalProperties: false,
};

const DESCRIPTIONS: Record<string, string> = {
  [LIST_MCP_RESOURCES]:
    'Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.',
  [LIST_MCP_RESOURCE_TEMPLATES]:
    'Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.',
  [READ_MCP_RESOURCE]:
    'Read a specific resource from an MCP server given the server name and resource URI.',
};

type Key = 'resources' | 'resourceTemplates';

function find(servers: readonly ResourceServer[], name: string): ResourceServer {
  const server = servers.find((candidate) => candidate.name === name);
  if (server) return server;
  const available = servers.map((candidate) => candidate.name).join(', ');
  throw new Error(
    `MCP server "${name}" has no resources${available ? `. Servers with resources: ${available}` : ''}`
  );
}

async function listing(
  servers: readonly ResourceServer[],
  params: unknown,
  signal: AbortSignal | undefined,
  key: Key
): Promise<Record<string, unknown>> {
  const serverName = stringArgument(params, 'server');
  const cursor = stringArgument(params, 'cursor');
  const visible = (item: object) => {
    const { uri, uriTemplate, mimeType } = item as Record<string, string | undefined>;
    const target = uri ?? uriTemplate ?? '';
    return !(target.startsWith('ui://') || /;\s*profile\s*=\s*"?mcp-app"?/i.test(mimeType ?? ''));
  };
  const options = (server: ResourceServer): McpRequestOptions => ({
    timeoutMs: server.connection.timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (serverName) {
    const server = find(servers, serverName);
    const page =
      key === 'resources'
        ? await server.connection.resourcesPage(cursor, options(server)).then((result) => ({
            items: result.resources as object[],
            nextCursor: result.nextCursor,
          }))
        : await server.connection.resourceTemplatesPage(cursor, options(server)).then((result) => ({
            items: result.resourceTemplates as object[],
            nextCursor: result.nextCursor,
          }));
    return {
      server: server.name,
      [key]: page.items.filter(visible).map((item) => listed(server.name, item)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
  if (cursor) throw new Error('cursor can only be used when a server is specified');
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  const results = await Promise.allSettled(
    sorted.map((server) =>
      key === 'resources'
        ? server.connection.allResources(options(server))
        : server.connection.allResourceTemplates(options(server))
    )
  );
  const items: Record<string, unknown>[] = [];
  const errors: { server: string; error: string }[] = [];
  results.forEach((result, index) => {
    const server = (sorted[index] as ResourceServer).name;
    if (result.status === 'fulfilled')
      items.push(...(result.value as object[]).filter(visible).map((item) => listed(server, item)));
    else
      errors.push({
        server,
        error: errorMessage(result.reason),
      });
  });
  return { [key]: items, ...(errors.length ? { errors } : {}) };
}

async function reading(
  servers: readonly ResourceServer[],
  params: unknown,
  signal: AbortSignal | undefined,
  save: Saver
): Promise<{ content: Content[]; payload: Record<string, unknown>; fullOutputPath?: string }> {
  const serverName = stringArgument(params, 'server');
  const uri = stringArgument(params, 'uri');
  if (!serverName) throw new Error('server must be provided');
  if (!uri) throw new Error('uri must be provided');
  const server = find(servers, serverName);
  const result = await server.connection.readResource(uri, {
    timeoutMs: server.connection.timeoutMs,
    ...(signal ? { signal } : {}),
  });
  const blocks = result.contents.flatMap((contents) => [
    ...(result.contents.length > 1 ? [{ type: 'text' as const, text: `${contents.uri}:` }] : []),
    { type: 'resource' as const, resource: contents },
  ]);
  const converted = await modelContent(server.name, blocks, save);
  const limited = await limitContent(
    converted.length ? converted : [{ type: 'text', text: `Resource ${uri} is empty.` }],
    save
  );
  const contents = result.contents.map((item) => {
    const { _meta: _ignored, ...rest } = item as typeof item & { _meta?: unknown };
    return rest;
  });
  return { ...limited, payload: { server: server.name, uri, contents } };
}

export type ServersFor = (
  api: ToolExecutionApi,
  context: Context
) => Promise<readonly ResourceServer[]>;

export function resourceTools(servers: ServersFor): ToolRegistration[] {
  const listTool = (name: string, key: Key) =>
    defineTool({
      name,
      description: DESCRIPTIONS[name] as string,
      parameters: LIST_PARAMETERS as never,
      replay: 'safe',
      async execute(args, api, context) {
        const payload = await listing(await servers(api, context), args, signalOf(context), key);
        const limited = await limitContent(
          [{ type: 'text', text: JSON.stringify(payload) }],
          apiSaver(api, '', context)
        );
        return { content: limited.content };
      },
    }) as ToolRegistration;
  return [
    listTool(LIST_MCP_RESOURCES, 'resources'),
    listTool(LIST_MCP_RESOURCE_TEMPLATES, 'resourceTemplates'),
    defineTool({
      name: READ_MCP_RESOURCE,
      description: DESCRIPTIONS[READ_MCP_RESOURCE] as string,
      parameters: READ_PARAMETERS as never,
      replay: 'safe',
      async execute(args, api, context) {
        const read = await reading(
          await servers(api, context),
          args,
          signalOf(context),
          apiSaver(api, '', context)
        );
        return { content: read.content };
      },
    }) as ToolRegistration,
  ];
}

export function resourceScriptTools(
  servers: () => readonly ResourceServer[],
  signal: AbortSignal | undefined,
  save: Saver
): CodemodeTool[] {
  const combine = (own: AbortSignal) => (signal ? AbortSignal.any([own, signal]) : own);
  return [
    {
      name: LIST_MCP_RESOURCES,
      description: DESCRIPTIONS[LIST_MCP_RESOURCES] as string,
      inputSchema: LIST_PARAMETERS,
      execute: (args, { signal: own }) => listing(servers(), args, combine(own), 'resources'),
    },
    {
      name: LIST_MCP_RESOURCE_TEMPLATES,
      description: DESCRIPTIONS[LIST_MCP_RESOURCE_TEMPLATES] as string,
      inputSchema: LIST_PARAMETERS,
      execute: (args, { signal: own }) =>
        listing(servers(), args, combine(own), 'resourceTemplates'),
    },
    {
      name: READ_MCP_RESOURCE,
      description: DESCRIPTIONS[READ_MCP_RESOURCE] as string,
      inputSchema: READ_PARAMETERS,
      execute: async (args, { signal: own }) =>
        (await reading(servers(), args, combine(own), save)).payload,
    },
  ];
}

export interface Namespace {
  name: string;
  description?: string;
  instructions?: string;
}

function isNamespaceName(namespace: string, query: string): boolean {
  const id = toCodemodeIdentifier(namespace);
  const queryId = toCodemodeIdentifier(query);
  const suffix = (name: string) => name.slice(name.lastIndexOf('__') + 2);
  return (
    namespace === query || id === queryId || suffix(namespace) === query || suffix(id) === queryId
  );
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}

export function rank(
  query: string,
  documents: readonly { name: string; text: string }[],
  limit: number
): string[] {
  const terms = words(query);
  if (!terms.length) return [];
  const tokenized = documents.map((doc) => ({ name: doc.name, words: words(doc.text) }));
  const frequency = new Map<string, number>();
  for (const doc of tokenized)
    for (const term of new Set(doc.words)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const total = tokenized.length;
  const scored = tokenized.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const count = doc.words.filter((word) => word === term || word.startsWith(term)).length;
      if (!count) continue;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      score += idf * ((count * 2.2) / (count + 1.2 * (0.25 + (0.75 * doc.words.length) / 20)));
    }
    return { name: doc.name, score };
  });
  return scored
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((doc) => doc.name);
}

export const DEFAULT_SEARCH_LIMIT = 8;

export function discoveryGlobals(
  tools: readonly CodemodeTool[],
  namespaceOf: (tool: string) => Namespace | undefined
): CodemodeTool[] {
  const samples = new Map(tools.map((tool) => [tool.name, renderToolSample(tool)]));
  const entry = (name: string) => ({
    name: toCodemodeIdentifier(name),
    description: samples.get(name) as string,
  });
  return [
    {
      name: 'searchTools',
      spread: true,
      execute: (args) => {
        const [query, options] = args as [
          unknown,
          { limit?: unknown; namespace?: unknown } | undefined,
        ];
        if (typeof query !== 'string') throw new Error('searchTools() expects a query string');
        const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)
          throw new Error('searchTools() limit must be a positive integer');
        const namespace = options?.namespace;
        if (namespace !== undefined && namespace !== null && typeof namespace !== 'string')
          throw new Error('searchTools() namespace must be a string');
        const documents = tools.flatMap((tool) => {
          const space = namespaceOf(tool.name);
          if (namespace && (!space || !isNamespaceName(space.name, namespace))) return [];
          return [
            {
              name: tool.name,
              text: [
                tool.name.replace(/_/g, ' '),
                tool.description as string,
                space?.description ?? '',
              ].join(' '),
            },
          ];
        });
        return rank(query, documents, limit).map(entry);
      },
    },
    {
      name: 'describeTool',
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== 'string') throw new Error('describeTool() expects a tool name');
        const tool = tools.find(
          (candidate) => candidate.name === name || toCodemodeIdentifier(candidate.name) === name
        );
        return tool ? samples.get(tool.name) : undefined;
      },
    },
    {
      name: 'describeNamespace',
      spread: true,
      execute: (args) => {
        const [name] = args as unknown[];
        if (typeof name !== 'string')
          throw new Error('describeNamespace() expects a namespace name');
        let found: Namespace | undefined;
        const names: string[] = [];
        for (const tool of tools) {
          const space = namespaceOf(tool.name);
          if (!space || !isNamespaceName(space.name, name)) continue;
          found ??= space;
          names.push(toCodemodeIdentifier(tool.name));
        }
        if (!found) return undefined;
        return {
          name: found.name,
          ...(found.description ? { description: found.description } : {}),
          ...(found.instructions ? { instructions: found.instructions } : {}),
          tools: names,
        };
      },
    },
  ];
}

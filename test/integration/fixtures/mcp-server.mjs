const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const encoder = new TextEncoder();

const baseTools = [
  {
    name: 'echo',
    title: 'Echo',
    description: 'Echo the text back',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  { name: 'big', description: 'Return a large text', inputSchema: { type: 'object' } },
  { name: 'image', description: 'Return an image', inputSchema: {} },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
  {
    name: 'slow',
    description: 'Report progress, then wait until cancelled',
    inputSchema: { type: 'object' },
  },
  {
    name: 'structured',
    description: 'Return structured content only',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { answer: { type: 'number' } } },
  },
];

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function sse(events, init = {}) {
  let push;
  let finish;
  const stream = new ReadableStream({
    start(controller) {
      push = (message) =>
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      finish = () => {
        try {
          controller.close();
        } catch {}
      };
    },
  });
  queueMicrotask(async () => {
    await events(push);
    if (!init.keepOpen) finish();
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', ...init.headers },
    }),
    push: (message) => push(message),
    close: () => finish(),
  };
}

export function createMcpServer(options = {}) {
  const state = {
    requests: [],
    cancelled: [],
    sessions: 0,
    deleted: 0,
    tools: [...(options.tools ?? baseTools)],
    streams: [],
    waiting: new Map(),
  };
  const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
  const callTool = async (message, push) => {
    const { name, arguments: args = {} } = message.params;
    if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
    if (name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(60 * 1024) }] };
    if (name === 'image') return { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] };
    if (name === 'fail') return { content: [], isError: true };
    if (name === 'structured') return { content: [], structuredContent: { answer: 42 } };
    if (name === 'slow') {
      const token = message.params._meta?.progressToken;
      if (token !== undefined && push)
        push({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken: token, progress: 1, total: 2, message: 'halfway' },
        });
      await new Promise((resolve) => state.waiting.set(String(message.id), resolve));
      return { content: [{ type: 'text', text: 'finished' }] };
    }
    if (options.call) return options.call(name, args);
    return { content: [{ type: 'text', text: `unknown ${name}` }], isError: true };
  };
  const answer = async (message, push) => {
    const { method, params } = message;
    if (method === 'initialize') {
      state.sessions++;
      return result(message.id, {
        protocolVersion: params.protocolVersion,
        capabilities: {
          ...(options.noTools ? {} : { tools: { listChanged: true } }),
          ...(options.resources ? { resources: {} } : {}),
          logging: {},
        },
        serverInfo: { name: options.name ?? 'fake', version: '1.0.0' },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      });
    }
    if (method === 'tools/list') {
      if (options.failList?.())
        return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'list broke' } };
      return result(message.id, { tools: state.tools });
    }
    if (method === 'tools/call') return result(message.id, await callTool(message, push));
    if (method === 'resources/list' && options.failResources)
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'resources broke' },
      };
    if (method === 'resources/list')
      return result(message.id, {
        ...(params?.cursor === undefined && options.paged ? { nextCursor: 'page-2' } : {}),
        resources: [
          { uri: 'note://1', name: 'note', mimeType: 'text/plain' },
          { uri: 'ui://app', name: 'app' },
        ],
      });
    if (method === 'resources/templates/list' && options.templates === 'broken')
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'templates broke' },
      };
    if (method === 'resources/templates/list' && options.templates === false)
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      };
    if (method === 'resources/templates/list')
      return result(message.id, {
        resourceTemplates: [{ uriTemplate: 'note://{id}', name: 'notes' }],
      });
    if (method === 'resources/read' && options.read)
      return result(message.id, options.read(params.uri));
    if (method === 'resources/read')
      return result(message.id, {
        contents: [{ uri: params.uri, mimeType: 'text/plain', text: `contents of ${params.uri}` }],
      });
    if (method === 'ping') return result(message.id, {});
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  };
  const cors = options.cors
    ? {
        'access-control-allow-origin': '*',
        'access-control-allow-headers':
          'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-expose-headers': 'mcp-session-id',
      }
    : {};
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const headers = Object.fromEntries(request.headers);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const body = request.method === 'POST' ? await request.json() : undefined;
    state.requests.push({ method: request.method, url: request.url, headers, body });
    const token = state.token ?? options.token;
    if (token && headers.authorization !== `Bearer ${token}`)
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="fake"', ...cors },
      });
    if (request.method === 'DELETE') {
      state.deleted++;
      return new Response(null, { status: 200, headers: cors });
    }
    if (request.method === 'GET') {
      if (!options.getStream) return new Response(null, { status: 405, headers: cors });
      const stream = sse(async () => undefined, { keepOpen: true, headers: cors });
      state.streams.push(stream);
      return stream.response;
    }
    if (body.method === 'notifications/cancelled') {
      state.cancelled.push(body.params.requestId);
      state.waiting.get(String(body.params.requestId))?.();
    }
    if (body.id === undefined) return new Response(null, { status: 202, headers: cors });
    const session = { 'mcp-session-id': 'session-1', ...cors };
    if (options.sse || body.params?.name === 'slow') {
      const stream = sse(async (push) => push(await answer(body, push)), { headers: session });
      return stream.response;
    }
    return json(await answer(body), { headers: session });
  };
  return {
    fetch,
    state,
    notify(method, params = {}) {
      for (const stream of state.streams) stream.push({ jsonrpc: '2.0', method, params });
    },
    setTools(tools) {
      state.tools = tools;
    },
    finish(id) {
      state.waiting.get(String(id))?.();
    },
  };
}

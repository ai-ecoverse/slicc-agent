const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MODELS = {
  object: 'list',
  data: [
    {
      id: 'chat-1',
      object: 'model',
      context_length: 131072,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    { id: 'chat-2', object: 'model', meta: { n_ctx: 65536 } },
    { id: 'chat-3', object: 'model', max_context_length: 12288 },
    { id: 'chat-4', object: 'model' },
    {
      id: 'judge-1',
      object: 'model',
      architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
    },
  ],
};

async function readRequest(reader) {
  let buffer = new Uint8Array(0);
  const more = async () => {
    const { done, value } = await reader.read();
    if (done) return false;
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer);
    next.set(value, buffer.length);
    buffer = next;
    return true;
  };
  let end = -1;
  for (;;) {
    end = decoder.decode(buffer).indexOf('\r\n\r\n');
    if (end >= 0) break;
    if (!(await more())) return undefined;
  }
  const [line, ...rest] = decoder.decode(buffer.slice(0, end)).split('\r\n');
  const [method, target] = line.split(' ');
  const headers = {};
  for (const header of rest) {
    const at = header.indexOf(':');
    headers[header.slice(0, at).trim().toLowerCase()] = header.slice(at + 1).trim();
  }
  const length = Number(headers['content-length'] ?? 0);
  const start = end + 4;
  while (buffer.length - start < length) if (!(await more())) break;
  return { method, target, headers, body: decoder.decode(buffer.slice(start, start + length)) };
}

async function reply(writer, status, body, type = 'application/json') {
  const bytes = encoder.encode(typeof body === 'string' ? body : JSON.stringify(body));
  const head = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Not Found'}\r\ncontent-type: ${type}\r\ncontent-length: ${bytes.length}\r\n\r\n`;
  await writer.write(encoder.encode(head));
  await writer.write(bytes);
}

const chunk = (delta, finish) =>
  `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'chat-1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

function completion(message) {
  const tool = message.messages.find((entry) => entry.role === 'tool');
  const asked = JSON.stringify(message.messages).includes('Run the local tool.');
  if (tool)
    return `${chunk({ role: 'assistant', content: `From the local server: ${String(tool.content).trim()}` }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
  if (asked && message.tools?.some((entry) => entry.function?.name === 'bash'))
    return `${chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_local', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo local-tool' }) } }] }, null)}${chunk({}, 'tool_calls')}data: [DONE]\n\n`;
  return `${chunk({ role: 'assistant', content: 'Fine.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
}

function decided(message) {
  const answers = Object.fromEntries(
    Object.entries(message.questions).map(([id, question]) => {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        const choice = keys.includes('routine') ? 'routine' : keys[0];
        const rest = (1 - 0.95) / Math.max(1, keys.length - 1);
        return [
          id,
          {
            type: 'choice',
            choice,
            confidence: 0.95,
            probabilities: Object.fromEntries(
              keys.map((key) => [key, key === choice ? 0.95 : rest])
            ),
          },
        ];
      }
      if (question.type === 'score') return [id, { type: 'score', score: 1, confidence: 0.9 }];
      return [id, { type: 'noul', noul: 0.95 }];
    })
  );
  return { answers };
}

async function answer(request, writer, ctx) {
  const message = request.body ? JSON.parse(request.body) : null;
  const seen = {
    method: request.method,
    target: request.target,
    authorization: request.headers.authorization ?? null,
    model: message?.model ?? null,
    maxTokens: message?.max_tokens ?? null,
  };
  await ctx.write(1, `seen ${JSON.stringify(seen)}\n`);
  if (request.method === 'GET' && request.target === '/v1/models')
    return reply(writer, 200, MODELS);
  if (request.method === 'POST' && request.target === '/v1/systemone')
    return reply(writer, 200, decided(message));
  if (request.method === 'POST' && request.target === '/v1/chat/completions')
    return reply(writer, 200, completion(message), 'text/event-stream');
  return reply(writer, 404, { error: 'not found' });
}

async function serve(connection, ctx) {
  const reader = connection.readable.getReader();
  const writer = connection.writable.getWriter();
  try {
    const request = await readRequest(reader);
    if (request) await answer(request, writer, ctx);
  } finally {
    await writer.close().catch(() => undefined);
    connection.close();
  }
}

export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: Number(ctx.argv[1] ?? 8820) });
  await ctx.write(1, `listening ${listener.port}\n`);
  for await (const connection of listener) void serve(connection, ctx).catch(() => undefined);
}

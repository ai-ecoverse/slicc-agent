const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back from the kernel loopback',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

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

function head(status, reason, headers) {
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return encoder.encode(`${lines.concat('', '').join('\r\n')}`);
}

async function plain(writer, status, reason, body = '', headers = {}) {
  const bytes = encoder.encode(body);
  await writer.write(head(status, reason, { ...headers, 'content-length': bytes.length }));
  if (bytes.length) await writer.write(bytes);
}

function chunk(text) {
  const bytes = encoder.encode(text);
  return encoder.encode(`${bytes.length.toString(16)}\r\n${text}\r\n`);
}

const event = (message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;

async function answer(request, writer, seen, bearer) {
  const origin = request.headers.origin;
  seen.push({ method: request.method, origin: origin ?? null });
  if (bearer && request.headers.authorization !== `Bearer ${bearer}`)
    return plain(writer, 401, 'Unauthorized', 'wrong token');
  if (origin && !LOOPBACK.test(new URL(origin).hostname))
    return plain(writer, 403, 'Forbidden', `origin ${origin} is not loopback`);
  if (request.target !== '/mcp') return plain(writer, 404, 'Not Found');
  if (request.method !== 'POST') return plain(writer, 405, 'Method Not Allowed');
  const message = JSON.parse(request.body);
  if (message.id === undefined) return plain(writer, 202, 'Accepted');
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const json = { 'content-type': 'application/json' };
  if (message.method === 'initialize')
    return plain(
      writer,
      200,
      'OK',
      JSON.stringify(
        reply({
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {}, logging: {} },
          serverInfo: { name: 'mcp-loop', version: '1.0.0' },
        })
      ),
      json
    );
  if (message.method === 'tools/list')
    return plain(writer, 200, 'OK', JSON.stringify(reply({ tools })), json);
  if (message.method === 'tools/call') {
    await writer.write(
      head(200, 'OK', {
        'content-type': 'text/event-stream',
        'transfer-encoding': 'chunked',
      })
    );
    await writer.write(
      chunk(
        event({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', logger: 'loop', data: 'streamed over the kernel loopback' },
        })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const origins = [...new Set(seen.map((entry) => entry.origin ?? 'none'))].join(',');
    const text = `echo: ${message.params.arguments.text} (origin ${origins}, ${request.headers['mcp-protocol-version'] ? 'versioned' : 'unversioned'}${bearer ? ', bearer' : ''})`;
    await writer.write(chunk(event(reply({ content: [{ type: 'text', text }] }))));
    await writer.write(encoder.encode('0\r\n\r\n'));
    return undefined;
  }
  return plain(
    writer,
    200,
    'OK',
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'method not found' },
    }),
    json
  );
}

async function serve(connection, seen, bearer) {
  const reader = connection.readable.getReader();
  const writer = connection.writable.getWriter();
  try {
    const request = await readRequest(reader);
    if (request) await answer(request, writer, seen, bearer);
  } finally {
    await writer.close().catch(() => undefined);
    connection.close();
  }
}

export default async function main(ctx) {
  const port = Number(ctx.argv[1] ?? 8810);
  const bearer = ctx.argv[2];
  const listener = await ctx.net.listen({ port });
  const seen = [];
  await ctx.write(1, `listening ${listener.port}\n`);
  for await (const connection of listener)
    void serve(connection, seen, bearer).catch(() => undefined);
}

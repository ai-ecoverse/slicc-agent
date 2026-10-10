import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { createMcpServer } from './fixtures/mcp-server.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.start = async (query, page) => {
    const { bootKernel } = await import('/kernel.js');
    const { fetchTransport } = await import(
      '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
    );
    await import('/dist-test/page.js');
    const kernel = await bootKernel({}, page ? { network: { transport: fetchTransport() } } : {});
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    window.agent = createAgentModel(await owner.connect(), { storage: localStorage }).agent;
    await window.agent.ready();
  };
  window.tools = () =>
    window.agent
      .messages()
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
  window.licks = () => window.agent.messages().filter((message) => message.role === 'lick');
};

async function serve(cors) {
  const fake = createMcpServer({ cors });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const answer = await fake.fetch(`http://${request.headers.host}${request.url}`, {
      method: request.method,
      headers: Object.entries(request.headers).filter(([, value]) => typeof value === 'string'),
      ...(body && request.method !== 'GET' ? { body } : {}),
    });
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) for await (const chunk of answer.body) response.write(chunk);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    fake,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => server.close(),
  };
}

const script =
  'const echoed = await tools.mcp__docs__structured({}); const found = await searchTools("echo text"); return { echoed, found: found.map((item) => item.name) };';

test('an MCP server behind the relay transport: a codemode script and a direct tool call', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = [
    'relay=mcp.test',
    `code=${encodeURIComponent(script)}`,
    `tool=${encodeURIComponent(JSON.stringify({ name: 'mcp__docs__echo', args: { text: 'relayed' } }))}`,
    'answer=Done.',
  ].join('&');
  await page.evaluate(async (q) => {
    await window.write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({
        mcpServers: { docs: { url: 'https://mcp.test/mcp', toolExposure: { echo: 'direct' } } },
      })
    );
    await window.start(q);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await window.agent.send(window.agent.active(), 'Use the docs.');
  }, query);
  await page.within(
    60000,
    () =>
      window.tools().filter((tool) => tool.status === 'done' || tool.status === 'error').length >= 2
  );
  const tools = await page.evaluate(() =>
    window.tools().map(({ name, output, status }) => ({ name, output, status }))
  );
  const [scripted, echo] = tools;
  assert.equal(scripted.name, 'codemode');
  assert.match(scripted.output, /"structuredContent":\{"answer":42\}/);
  assert.match(scripted.output, /"found":\["mcp__docs__echo"/);
  assert.equal(echo.name, 'mcp__docs__echo');
  assert.equal(echo.output, 'echo: relayed');
});

test('on the page route a server with CORS works and one without CORS is reported once', async (t) => {
  const open = await serve(true);
  const closed = await serve(false);
  try {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const query = [
      { answer: 'Noted.' },
      { tool: { name: 'mcp__open__echo', args: { text: 'direct' } } },
      { answer: 'Done.' },
    ]
      .map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`)
      .join('&');
    await page.evaluate(
      async ({ q, open, closed }) => {
        await window.write(
          '/home/.pi/agent/mcp.json',
          JSON.stringify({
            mcpServers: { open: { url: open, exposure: 'direct' }, closed: { url: closed } },
          })
        );
        await window.start(q, true);
      },
      { q: query, open: open.url, closed: closed.url }
    );
    await page.within(60000, () => window.licks().some((lick) => /closed/.test(lick.title ?? '')));
    await page.within(60000, () => !window.agent.busy(window.agent.active()));
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await window.agent.send(window.agent.active(), 'Call it.');
    });
    await page.within(60000, () =>
      window.tools().some((tool) => tool.status === 'done' || tool.status === 'error')
    );
    const seen = await page.evaluate(() => ({
      tools: window.tools().map(({ name, output }) => ({ name, output })),
      licks: window.licks().map(({ title, text }) => ({ title, text })),
    }));
    assert.deepEqual(
      seen.tools,
      [{ name: 'mcp__open__echo', output: 'echo: direct' }],
      JSON.stringify(seen.licks)
    );
    const blocked = seen.licks.filter((lick) => lick.title === `MCP server "closed" can't connect`);
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].text, /no CORS headers/);
    assert.ok(open.fake.state.requests.some((request) => request.body?.method === 'tools/call'));
  } finally {
    open.close();
    closed.close();
  }
});

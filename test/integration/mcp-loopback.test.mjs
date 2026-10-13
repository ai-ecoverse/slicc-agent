import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const program = await readFile(new URL('./fixtures/mcp-loop.mjs', import.meta.url), 'utf8');
const manifest = JSON.stringify({
  name: 'mcp-loop',
  version: '1.0.0',
  slicc: { commands: { 'mcp-loop': { abi: 'js', module: 'server.mjs' } } },
});

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
  window.read = async (path) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    try {
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return '';
    }
  };
  window.boot = async (route, files, argv = ['mcp-loop', '8810']) => {
    for (const [path, text] of Object.entries(files)) await window.write(path, text);
    const { bootKernel } = await import('/kernel.js');
    const { attachKernel, fetchTransport } = await import(
      '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
    );
    await import('/dist-test/page.js');
    window.kernel = await bootKernel(
      {},
      route === 'page' ? { network: { transport: fetchTransport() } } : {}
    );
    const client = await attachKernel(await window.kernel.connect());
    let out = '';
    const decoder = new TextDecoder();
    const listening = new Promise((resolve) => {
      client.spawn(argv, {
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
          if (out.includes('listening')) resolve(out.trim());
        },
        onStderr: (bytes) => console.error(decoder.decode(bytes)),
      });
    });
    return listening;
  };
  window.start = async (query) => {
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: { connect: () => window.kernel.connect() },
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
};

for (const route of ['page', 'relay']) {
  test(`an MCP server a kernel program serves on the kernel loopback is reached on the ${route} route`, async (t) => {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const listening = await page.evaluate((r, files) => window.boot(r, files), route, {
      '/node_modules/mcp-loop/package.json': manifest,
      '/node_modules/mcp-loop/server.mjs': program,
      '/home/.pi/agent/mcp.json': JSON.stringify({
        mcpServers: {
          loop: { url: 'http://8810.kernel.localhost/mcp', toolExposure: { echo: 'direct' } },
        },
      }),
    });
    assert.equal(listening, 'listening 8810');
    const query = [
      ...(route === 'relay' ? ['relay=mcp.test'] : []),
      `tool=${encodeURIComponent(JSON.stringify({ name: 'mcp__loop__echo', args: { text: 'kernel' } }))}`,
      'answer=Done.',
    ].join('&');
    await page.evaluate((q) => window.start(q), query);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await page.evaluate(() => window.agent.send(window.agent.active(), 'Echo through the loop.'));
    await page.within(60000, () =>
      window.tools().some((tool) => tool.status === 'done' || tool.status === 'error')
    );
    const { tools, licks } = await page.evaluate(() => ({
      tools: window.tools().map(({ name, output, status }) => ({ name, output, status })),
      licks: window.agent
        .messages()
        .filter((message) => message.role === 'lick')
        .map(({ title, text }) => ({ title, text })),
    }));
    const [echo] = tools;
    assert.deepEqual(
      echo,
      {
        name: 'mcp__loop__echo',
        status: 'done',
        output: 'echo: kernel (origin none, versioned)',
      },
      JSON.stringify(licks)
    );
    await page.within(10000, async () =>
      (await window.read('/home/.pi/agent/mcp.log')).includes('streamed over the kernel loopback')
    );
  });
}

test('a bridge token sealed in the vault reaches a kernel-loopback MCP server, filled by the vault in the agent request', async (t) => {
  const token = 'loop-bridge-token-0001';
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const listening = await page.evaluate(
    (files, argv) => window.boot('page', files, argv),
    {
      '/node_modules/mcp-loop/package.json': manifest,
      '/node_modules/mcp-loop/server.mjs': program,
      '/home/.pi/agent/mcp.json': JSON.stringify({
        mcpServers: {
          loop: {
            url: 'http://8811.kernel.localhost/mcp',
            headers: { Authorization: 'Bearer ${MCP_LOOP_TOKEN}' },
            toolExposure: { echo: 'direct' },
          },
        },
      }),
    },
    ['mcp-loop', '8811', token]
  );
  assert.equal(listening, 'listening 8811');
  const record = {
    kind: 'mcp',
    name: 'MCP_LOOP_TOKEN',
    server: 'loop',
    placeholder: 'fnox_proxy_loop',
    value: token,
  };
  const query = [
    'vault',
    `record=${encodeURIComponent(JSON.stringify(record))}`,
    `tool=${encodeURIComponent(JSON.stringify({ name: 'mcp__loop__echo', args: { text: 'sealed' } }))}`,
    'answer=Done.',
  ].join('&');
  await page.evaluate((q) => window.start(q), query);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await page.evaluate(() =>
    window.agent.send(window.agent.active(), 'Echo through the sealed loop.')
  );
  await page.within(60000, () =>
    window.tools().some((tool) => tool.status === 'done' || tool.status === 'error')
  );
  const seen = await page.evaluate(() => ({
    tools: window.tools().map(({ name, output, status }) => ({ name, output, status })),
    messages: JSON.stringify(window.agent.messages()),
  }));
  assert.deepEqual(seen.tools, [
    {
      name: 'mcp__loop__echo',
      status: 'done',
      output: 'echo: sealed (origin none, versioned, bearer)',
    },
  ]);
  assert.ok(!seen.messages.includes(token));
});

test("an MCP entry on the CDP facade's 9222.kernel.localhost is refused before anything is sent", async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate((files) => window.boot('page', files), {
    '/node_modules/mcp-loop/package.json': manifest,
    '/node_modules/mcp-loop/server.mjs': program,
    '/home/.pi/agent/mcp.json': JSON.stringify({
      mcpServers: { facade: { url: 'http://9222.kernel.localhost/mcp' } },
    }),
  });
  await page.evaluate(() => window.start('answer=Noted.&answer=Noted.'));
  await page.within(60000, () =>
    window.agent
      .messages()
      .some((message) => message.role === 'lick' && /facade/.test(message.title ?? ''))
  );
  const lick = await page.evaluate(() =>
    window.agent
      .messages()
      .filter((message) => message.role === 'lick')
      .map(({ title, text }) => ({ title, text }))
      .find((message) => /facade/.test(message.title))
  );
  assert.equal(lick.title, 'MCP server "facade" can\'t connect');
  assert.match(
    lick.text,
    /9222\.kernel\.localhost isn't a kernel server SLICC may reach: use <port>\.kernel\.localhost with a port from 1 to 65535 other than 9222, the CDP facade/
  );
});

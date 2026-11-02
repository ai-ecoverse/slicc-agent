import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const RESOURCES = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
const INTERESTING = new Set(['tool_search', 'codemode', 'mcp__docs__echo', ...RESOURCES]);

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
  window.start = async (query) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () =>
        (window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    window.model = createAgentModel(await owner.connect(), { storage: localStorage });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.tools = () =>
    window.agent
      .messages()
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
};

function queryOf(steps) {
  const params = new URLSearchParams([['relay', 'mcp.test']]);
  for (const step of steps) params.append('step', JSON.stringify(step));
  return params.toString();
}

async function boot(page, steps, settings) {
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate((settings) => {
    const writes = [
      window.write(
        '/home/.pi/agent/mcp.json',
        JSON.stringify({
          mcpServers: { docs: { url: 'https://mcp.test/mcp', exposure: 'deferred' } },
        })
      ),
    ];
    if (settings)
      writes.push(window.write('/home/.pi/agent/settings.json', JSON.stringify(settings)));
    return Promise.all(writes);
  }, settings);
  await staged(page, 'the agent', (query) => window.start(query), queryOf(steps));
  await page.within(60000, () =>
    window.model.settings
      .accounts()
      .some(({ id, state }) => id === 'mcp:docs' && state === 'connected')
  );
}

async function run(page, count) {
  await page.evaluate((count) => {
    window.expected = count;
    return window.agent.send(window.agent.active(), 'Use the docs.');
  }, count);
  await page.within(60000, () => {
    const finished = window
      .tools()
      .filter((tool) => tool.status === 'done' || tool.status === 'error');
    return finished.length >= window.expected && !window.agent.busy(window.agent.active());
  });
  return page.evaluate(async () => {
    const { port1, port2 } = new MessageChannel();
    const requests = new Promise((resolve) => {
      port1.onmessage = ({ data }) => resolve(data);
    });
    window.worker.postMessage({ requests: port2 }, [port2]);
    return {
      tools: window.tools().map(({ name, output, status }) => ({ name, output, status })),
      requests: (await requests).map((context) => {
        const tools = new Map();
        for (const message of JSON.parse(context).messages ?? []) {
          if (message.role !== 'system') continue;
          for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
          for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool.name);
        }
        return [...tools.keys()];
      }),
    };
  });
}

function offered(names) {
  return names.filter((name) => INTERESTING.has(name)).sort();
}

function brief(seen) {
  const tools = seen.tools
    .map((tool) => `${tool.status} ${tool.name}: ${String(tool.output).slice(0, 240)}`)
    .join('\n');
  const requests = seen.requests.map((names, index) => `${index}: ${offered(names).join(', ')}`);
  return `${tools}\n${requests.join('\n')}`;
}

const early = "const echoed = await tools.mcp__docs__echo({ text: 'early' }); return echoed;";

test('tool_search loads a deferred tool after codemode has called it, and loads deferred resource tools', async (t) => {
  const page = await chrome.page(t);
  const steps = [
    { tool: { name: 'codemode', args: { code: early } } },
    { tool: { name: 'tool_search', args: { query: 'echo' } } },
    { tool: { name: 'mcp__docs__echo', args: { text: 'loaded' } } },
    { tool: { name: 'tool_search', args: { query: 'resources' } } },
    { tool: { name: 'list_mcp_resources', args: {} } },
    { tool: { name: 'read_mcp_resource', args: { server: 'docs', uri: 'note://1' } } },
    { answer: 'Done.' },
  ];
  await boot(page, steps);
  const seen = await run(page, 6);
  const detail = brief(seen);
  const [scripted, found, echo, resources, listed, read] = seen.tools;
  assert.equal(scripted.name, 'codemode', detail);
  assert.equal(scripted.status, 'done', detail);
  assert.match(scripted.output, /echo: early/, detail);
  assert.equal(found.name, 'tool_search', detail);
  assert.match(found.output, /Loaded \d+ tool/, detail);
  assert.match(found.output, /mcp__docs__echo/, detail);
  assert.equal(echo.name, 'mcp__docs__echo', detail);
  assert.equal(echo.output, 'echo: loaded', detail);
  assert.equal(resources.name, 'tool_search', detail);
  assert.match(resources.output, /Loaded \d+ tools/, detail);
  for (const name of RESOURCES) assert.match(resources.output, new RegExp(name), detail);
  assert.equal(listed.name, 'list_mcp_resources', detail);
  assert.match(listed.output, /"uri":"note:\/\/1"/, detail);
  assert.equal(read.name, 'read_mcp_resource', detail);
  assert.match(read.output, /contents of note:\/\/1/, detail);
  assert.ok(seen.requests.length >= 7, detail);
  assert.deepEqual(offered(seen.requests[0]), ['codemode', 'tool_search'], detail);
  assert.deepEqual(offered(seen.requests[1]), ['codemode', 'tool_search'], detail);
  assert.ok(seen.requests[2].includes('mcp__docs__echo'), detail);
  assert.equal(seen.requests[2].includes('list_mcp_resources'), false, detail);
  for (const name of ['mcp__docs__echo', ...RESOURCES])
    assert.ok(seen.requests[4].includes(name), detail);
});

test('with tool_search off, a deferred server stays on codemode and off the model tools', async (t) => {
  const page = await chrome.page(t);
  const code =
    "const echoed = await tools.mcp__docs__echo({ text: 'early' }); const listed = await tools.list_mcp_resources({}); return { echoed, listed };";
  const steps = [{ tool: { name: 'codemode', args: { code } } }, { answer: 'Done.' }];
  await boot(page, steps, { defaultTools: ['-tool_search'] });
  const seen = await run(page, 1);
  const detail = brief(seen);
  assert.equal(seen.tools[0].name, 'codemode', detail);
  assert.equal(seen.tools[0].status, 'done', detail);
  assert.match(seen.tools[0].output, /echo: early/, detail);
  assert.match(seen.tools[0].output, /note:\/\/1/, detail);
  assert.deepEqual(offered(seen.requests[0]), ['codemode'], detail);
});

test('with tool_search and codemode off, a deferred server and its resource tools are direct', async (t) => {
  const page = await chrome.page(t);
  const steps = [
    { tool: { name: 'mcp__docs__echo', args: { text: 'loaded' } } },
    { tool: { name: 'read_mcp_resource', args: { server: 'docs', uri: 'note://1' } } },
    { answer: 'Done.' },
  ];
  await boot(page, steps, { defaultTools: ['-tool_search', '-codemode'] });
  const seen = await run(page, 2);
  const detail = brief(seen);
  assert.equal(seen.tools[0].name, 'mcp__docs__echo', detail);
  assert.equal(seen.tools[0].output, 'echo: loaded', detail);
  assert.equal(seen.tools[1].name, 'read_mcp_resource', detail);
  assert.match(seen.tools[1].output, /contents of note:\/\/1/, detail);
  assert.deepEqual(offered(seen.requests[0]), ['mcp__docs__echo', ...RESOURCES].sort(), detail);
});

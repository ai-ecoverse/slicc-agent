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
  window.licks = () => window.agent.messages().filter((message) => message.role === 'lick');
};

async function serve(cors, extra = {}) {
  const fake = createMcpServer({ cors, ...extra });
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

test('an MCP server behind the relay transport answering with SSE: a codemode script and a direct tool call', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = [
    'relay=mcp.test',
    'sse=1',
    `code=${encodeURIComponent(script)}`,
    `tool=${encodeURIComponent(JSON.stringify({ name: 'mcp__docs__echo', args: { text: 'relayed' } }))}`,
    'answer=Done.',
  ].join('&');
  await page.evaluate(() =>
    window.write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({
        mcpServers: { docs: { url: 'https://mcp.test/mcp', toolExposure: { echo: 'direct' } } },
      })
    )
  );
  await page.evaluate((q) => window.start(q), query);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await page.evaluate(() => window.agent.send(window.agent.active(), 'Use the docs.'));
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
      ({ open, closed }) =>
        window.write(
          '/home/.pi/agent/mcp.json',
          JSON.stringify({
            mcpServers: { open: { url: open, exposure: 'direct' }, closed: { url: closed } },
          })
        ),
      { open: open.url, closed: closed.url }
    );
    await page.evaluate((q) => window.start(q, true), query);
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

test('an OAuth MCP server signs in through a popup and the callback page, and without a vault no token is ever exchanged', async (t) => {
  const docs = await serve(true, { oauth: {} });
  try {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const query = [
      'redirect=/dist/oauth/mcp-callback.html',
      { answer: 'Noted.' },
      { tool: { name: 'mcp__docs__echo', args: { text: 'signed in' } } },
      { answer: 'Done.' },
    ]
      .map((step) =>
        typeof step === 'string' ? step : `step=${encodeURIComponent(JSON.stringify(step))}`
      )
      .join('&');
    await page.evaluate(
      (url) =>
        window.write(
          '/home/.pi/agent/mcp.json',
          JSON.stringify({ mcpServers: { docs: { url, exposure: 'direct' } } })
        ),
      docs.url
    );
    await page.evaluate((q) => window.start(q, true), query);
    await page.within(60000, () =>
      window.model.settings
        .accounts()
        .some((account) => account.id === 'mcp:docs' && account.auth === 'oauth')
    );
    await page.send('Runtime.evaluate', {
      expression:
        "window.signing = window.model.settings.connect('mcp:docs').then(() => 'ok', (error) => String(error))",
      userGesture: true,
    });
    const signed = await page.evaluate(() => window.signing);
    assert.match(signed, /MCP sign-in needs seven's vault: update seven/);
    assert.equal(docs.fake.state.oauth.authorizations.length, 1);
    assert.equal(docs.fake.state.oauth.issued, 0);
    assert.equal(
      docs.fake.state.oauth.clients[0].redirect_uris[0].endsWith('/dist/oauth/mcp-callback.html'),
      true
    );
  } finally {
    docs.close();
  }
});

test('Cancel during an MCP sign-in closes its window, drops its state and rejects with an AbortError at once, even while discovery is still waiting', async (t) => {
  let gate;
  const docs = await serve(true, { oauth: { hold: () => gate } });
  try {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.init(() => {
      window.opens = [];
      window.open = (url) => {
        const popup = {
          closed: false,
          location: { href: url },
          close() {
            popup.closed = true;
          },
        };
        window.opens.push(popup);
        return popup;
      };
    });
    await page.goto('/');
    await page.evaluate(
      (url) =>
        window.write(
          '/home/.pi/agent/mcp.json',
          JSON.stringify({ mcpServers: { docs: { url, exposure: 'direct' } } })
        ),
      docs.url
    );
    await page.evaluate(() => window.start('answer=Noted.', true));
    await page.within(60000, () =>
      window.model.settings
        .accounts()
        .some((account) => account.id === 'mcp:docs' && account.auth === 'oauth')
    );
    let release;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const sign = () =>
      page.evaluate(() => {
        const before = window.opens.length;
        window.signing = window.model.settings.connect('mcp:docs').then(
          () => 'ok',
          (error) => error.name
        );
        return window.opens.length - before;
      });
    const cancel = () =>
      page.evaluate(async () => {
        const status = () =>
          window.model.settings.accounts().find((account) => account.id === 'mcp:docs').status;
        for (let n = 0; n < 500 && status() !== 'signing-in'; n++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        window.model.settings.cancel('mcp:docs');
        let result;
        window.signing.then((value) => {
          result = value;
        });
        for (let n = 0; n < 50 && result === undefined; n++)
          await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          result,
          closed: window.opens.at(-1).closed,
          href: window.opens.at(-1).location.href,
          states: Object.keys(localStorage).filter((key) => key.startsWith('slicc-mcp-oauth:')),
          status: status(),
        };
      });
    assert.equal(await sign(), 1);
    assert.deepEqual(await cancel(), {
      result: 'AbortError',
      closed: true,
      href: 'about:blank',
      states: [],
      status: 'disconnected',
    });
    release();
    gate = undefined;
    assert.equal(await sign(), 1);
    await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
    const waiting = await cancel();
    assert.equal(waiting.result, 'AbortError');
    assert.equal(waiting.closed, true);
    assert.deepEqual(waiting.states, []);
    assert.equal(docs.fake.state.oauth.issued, 0);
  } finally {
    docs.close();
  }
});

test('a retry right after a cancelled MCP sign-in keeps its own state, even when the cancelled discovery finishes last', async (t) => {
  const held = [];
  let holding = false;
  const hold = (url) => {
    if (!holding || !url.pathname.startsWith('/.well-known/oauth-protected-resource')) return;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    held.push(release);
    return gate;
  };
  const docs = await serve(true, { oauth: { hold } });
  try {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.init(() => {
      window.opens = [];
      window.open = (url) => {
        const popup = {
          closed: false,
          location: { href: url },
          close() {
            popup.closed = true;
          },
        };
        window.opens.push(popup);
        return popup;
      };
    });
    await page.goto('/');
    await page.evaluate(
      (url) =>
        window.write(
          '/home/.pi/agent/mcp.json',
          JSON.stringify({ mcpServers: { docs: { url, exposure: 'direct' } } })
        ),
      docs.url
    );
    await page.evaluate(() => window.start('answer=Noted.'));
    await page.within(60000, () =>
      window.model.settings
        .accounts()
        .some((account) => account.id === 'mcp:docs' && account.auth === 'oauth')
    );
    holding = true;
    await page.evaluate(() => {
      window.first = window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.name
      );
    });
    for (let n = 0; n < 500 && !held.length; n++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(held.length, 1);
    const cancelled = await page.evaluate(async () => {
      window.model.settings.cancel('mcp:docs');
      const result = await window.first;
      window.retry = window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.message
      );
      return result;
    });
    assert.equal(cancelled, 'AbortError');
    for (let n = 0; n < 15 && held.length < 2; n++) await new Promise((r) => setTimeout(r, 20));
    const stale = held.shift();
    holding = false;
    for (const release of held.splice(0)) release();
    const authorizing = () =>
      page.evaluate(() => window.opens.at(-1).location.href.includes('/authorize'));
    for (let n = 0; n < 50 && !(await authorizing()); n++)
      await new Promise((r) => setTimeout(r, 20));
    stale();
    await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
    await new Promise((r) => setTimeout(r, 500));
    const retried = await page.evaluate(async () => {
      const state = new URL(window.opens.at(-1).location.href).searchParams.get('state');
      new BroadcastChannel('slicc-mcp-oauth').postMessage({ code: 'code-x', state });
      return window.retry;
    });
    assert.match(retried, /MCP sign-in needs seven's vault: update seven/);
  } finally {
    docs.close();
  }
});

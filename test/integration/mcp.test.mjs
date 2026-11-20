import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';
import { createMcpServer } from './fixtures/mcp-server.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.holds = [];
  window.bases = [];
  window.holding = 'held';
  window.basing = 'based';
  const owner = new BroadcastChannel('slicc-held');
  window.answerHold = (marker, type) => owner.postMessage({ type, marker });
  owner.onmessage = ({ data }) => {
    if (data.type === 'base') {
      window.bases.push({ ...data, opened: window.opens?.length ?? 0 });
      if (window.basing === 'based') window.answerHold(data.marker, 'based');
      return;
    }
    window.holds.push({ ...data, href: window.opens?.at(-1)?.location.href });
    if (['held', 'none', 'unheld'].includes(window.holding))
      window.answerHold(data.marker, window.holding);
  };
  const Channel = BroadcastChannel;
  window.live = new Set();
  window.BroadcastChannel = class extends Channel {
    constructor(name) {
      super(name);
      if (name === 'slicc-held') window.live.add(this);
    }
    close() {
      window.live.delete(this);
      super.close();
    }
  };
  window.opened = async (before) => {
    for (let n = 0; n < 1500 && window.opens.length <= before; n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return window.opens.at(-1);
  };
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.start = async (query, page, base = '/dist-test/') => {
    const { bootKernel } = await import('/kernel.js');
    const { fetchTransport } = await import(
      '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
    );
    await import('/dist-test/page.js');
    const kernel = await bootKernel({}, page ? { network: { transport: fetchTransport() } } : {});
    const owner = await startAgent({
      worker: () =>
        (window.worker = new Worker(`${base}main-worker.js?${query}`, { type: 'module' })),
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
  window.own = () =>
    new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => resolve(data);
      window.worker.postMessage({ own: port2 }, [port2]);
    });
  window.account = (id) => window.model.settings.accounts().find((account) => account.id === id);
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
  await staged(page, 'the agent', (q) => window.start(q), query);
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
    await staged(page, 'the agent', (q) => window.start(q, true), query);
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

test('a server added in Settings without a token that answers 401 offers the OAuth sign-in, and its connected lick names the host only', async (t) => {
  const docs = await serve(true, { oauth: {} });
  const open = await serve(true);
  try {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    await staged(page, 'the agent', (q) => window.start(q, true), 'answer=Ready.');
    const added = await page.evaluate(
      (url) => window.model.settings.addServer('docs', { url }),
      docs.url
    );
    assert.deepEqual(added, { ok: true });
    await page.within(60000, () =>
      window.model.settings
        .accounts()
        .some(
          ({ id, auth, status, state }) =>
            id === 'mcp:docs' &&
            auth === 'oauth' &&
            status === 'disconnected' &&
            state === 'needs-auth'
        )
    );
    await page.evaluate((url) => window.model.settings.addServer('open', { url }), open.url);
    await page.within(60000, () =>
      window.licks().some((lick) => lick.title === 'MCP server "open" connected')
    );
    const lick = await page.evaluate(
      () => window.licks().find((item) => item.title === 'MCP server "open" connected').text
    );
    assert.match(lick, new RegExp(`^${new URL(open.url).host} offers \\d+ tools\\.$`));
  } finally {
    docs.close();
    open.close();
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
    await staged(page, 'the agent', (q) => window.start(q, true), query);
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
    await staged(page, 'the agent', () => window.start('answer=Noted.', true));
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
      page.evaluate(async () => {
        const before = window.opens.length;
        window.signing = window.model.settings.connect('mcp:docs').then(
          () => 'ok',
          (error) => error.name
        );
        await window.opened(before);
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
    const cancelled = await cancel();
    assert.match(cancelled.href, /^about:blank#slicc-sign-in-[0-9a-f-]{36}$/);
    assert.deepEqual(cancelled, {
      result: 'AbortError',
      closed: true,
      href: cancelled.href,
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

const fakePopups = () => {
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
};

async function mcpPage(t, docs, { query = 'answer=Noted.', config, base = '/dist-test/' } = {}) {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(fakePopups);
  await page.goto('/');
  await page.evaluate(
    (url, config) =>
      window.write(
        '/home/.pi/agent/mcp.json',
        JSON.stringify({ mcpServers: { docs: { url, exposure: 'direct', ...config } } })
      ),
    docs.url,
    config
  );
  await page.evaluate((query, base) => window.start(query, true, base), query, base);
  await page.within(60000, () =>
    window.model.settings
      .accounts()
      .some((account) => account.id === 'mcp:docs' && account.auth === 'oauth')
  );
  return page;
}

for (const answer of ['held', 'none']) {
  test(`an MCP sign-in opens its window on the held marker and sends it to the authorization server only once the owner answers ${answer}`, async (t) => {
    const docs = await serve(true, { oauth: {} });
    try {
      const page = await mcpPage(t, docs);
      const marked = await page.evaluate(async () => {
        window.holding = 'later';
        window.signing = window.model.settings.connect('mcp:docs').then(
          () => 'ok',
          (error) => error.message
        );
        return (await window.opened(0)).location.href;
      });
      assert.match(marked, /^about:blank#slicc-sign-in-[0-9a-f-]{36}$/);
      await page.within(30000, () => window.holds.length === 1);
      for (let n = 0; n < 1500 && !docs.fake.state.oauth.clients.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const waiting = await page.evaluate(() => ({
        asked: window.holds[0],
        href: window.opens.at(-1).location.href,
      }));
      assert.deepEqual(waiting, {
        asked: {
          type: 'hold',
          marker: marked.slice('about:blank#slicc-sign-in-'.length),
          based: true,
          expect: 1,
          href: marked,
        },
        href: marked,
      });
      await page.evaluate((answer) => window.answerHold('another', answer), answer);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(await page.evaluate(() => window.opens.at(-1).location.href), marked);
      await page.evaluate((answer) => window.answerHold(window.holds[0].marker, answer), answer);
      await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
      const result = await page.evaluate(() => {
        const state = new URL(window.opens.at(-1).location.href).searchParams.get('state');
        new BroadcastChannel('slicc-mcp-oauth').postMessage({ code: 'code-x', state });
        return window.signing;
      });
      assert.match(result, /MCP sign-in needs seven's vault: update seven/);
    } finally {
      docs.close();
    }
  });
}

test('an MCP sign-in asks the owner for a baseline before its window opens, then asks for the hold against that baseline', async (t) => {
  const docs = await serve(true, { oauth: {} });
  try {
    const page = await mcpPage(t, docs);
    const waiting = await page.evaluate(async () => {
      window.basing = 'later';
      window.signing = window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.message
      );
      for (let n = 0; n < 1500 && !window.bases.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { bases: window.bases, opens: window.opens.length, holds: window.holds.length };
    });
    const [{ marker }] = waiting.bases;
    assert.match(marker, /^[0-9a-f-]{36}$/);
    assert.deepEqual(waiting, { bases: [{ type: 'base', marker, opened: 0 }], opens: 0, holds: 0 });
    const seen = await page.evaluate(async (marker) => {
      window.answerHold('another', 'based');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const early = window.opens.length;
      window.answerHold(marker, 'based');
      await window.opened(0);
      for (let n = 0; n < 1500 && !window.holds.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return { early, opens: window.opens.length, asked: window.holds };
    }, marker);
    assert.deepEqual(seen, {
      early: 0,
      opens: 1,
      asked: [
        {
          type: 'hold',
          marker,
          based: true,
          expect: 1,
          href: `about:blank#slicc-sign-in-${marker}`,
        },
      ],
    });
    await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
    const result = await page.evaluate(() => {
      const state = new URL(window.opens.at(-1).location.href).searchParams.get('state');
      new BroadcastChannel('slicc-mcp-oauth').postMessage({ code: 'code-x', state });
      return window.signing;
    });
    assert.match(result, /MCP sign-in needs seven's vault: update seven/);
    assert.equal(await page.evaluate(() => window.live.size), 0);
  } finally {
    docs.close();
  }
});

test('an MCP sign-in whose baseline goes unanswered still opens its window held, with a plain hold ask', async (t) => {
  const docs = await serve(true, { oauth: {} });
  try {
    const page = await mcpPage(t, docs);
    const seen = await page.evaluate(async () => {
      window.basing = 'silent';
      const started = Date.now();
      window.signing = window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.message
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const early = window.opens.length;
      const popup = await window.opened(0);
      const waited = Date.now() - started;
      for (let n = 0; n < 1500 && !window.holds.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return { early, waited, bases: window.bases.length, asked: window.holds, popup: !!popup };
    });
    const marker = seen.asked[0]?.marker;
    assert.ok(seen.waited >= 5500, `opened after ${seen.waited} ms`);
    assert.deepEqual(seen, {
      early: 0,
      waited: seen.waited,
      bases: 1,
      asked: [{ type: 'hold', marker, href: `about:blank#slicc-sign-in-${marker}` }],
      popup: true,
    });
    await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
    const result = await page.evaluate(() => {
      const state = new URL(window.opens.at(-1).location.href).searchParams.get('state');
      new BroadcastChannel('slicc-mcp-oauth').postMessage({ code: 'code-x', state });
      return window.signing;
    });
    assert.match(result, /MCP sign-in needs seven's vault: update seven/);
  } finally {
    docs.close();
  }
});

test('Cancel while an MCP sign-in waits for its baseline opens no window, asks for no hold and leaves no channel open', async (t) => {
  const docs = await serve(true, { oauth: {} });
  try {
    const page = await mcpPage(t, docs);
    const seen = await page.evaluate(async () => {
      window.basing = 'later';
      window.signing = window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.name
      );
      for (let n = 0; n < 1500 && !window.bases.length; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      window.model.settings.cancel('mcp:docs');
      let result;
      window.signing.then((value) => {
        result = value;
      });
      for (let n = 0; n < 50 && result === undefined; n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const live = window.live.size;
      window.answerHold(window.bases[0].marker, 'based');
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        result,
        live,
        opens: window.opens.length,
        holds: window.holds.length,
        states: Object.keys(localStorage).filter((key) => key.startsWith('slicc-mcp-oauth:')),
        status: window.model.settings.accounts().find((account) => account.id === 'mcp:docs')
          .status,
      };
    });
    assert.deepEqual(seen, {
      result: 'AbortError',
      live: 0,
      opens: 0,
      holds: 0,
      states: [],
      status: 'disconnected',
    });
    assert.deepEqual(docs.fake.state.oauth.authorizations, []);
  } finally {
    docs.close();
  }
});

for (const holding of ['unheld', 'silent']) {
  test(`an MCP sign-in whose window the owner doesn't hold (${holding}) never sends the window anywhere and fails closed`, async (t) => {
    const docs = await serve(true, { oauth: {} });
    try {
      const page = await mcpPage(t, docs);
      const seen = await page.evaluate(async (holding) => {
        window.holding = holding;
        const result = await window.model.settings.connect('mcp:docs').then(
          () => 'ok',
          (error) => error.message
        );
        const popup = window.opens.at(-1);
        return {
          result,
          href: popup.location.href,
          closed: popup.closed,
          asked: window.holds.length,
          states: Object.keys(localStorage).filter((key) => key.startsWith('slicc-mcp-oauth:')),
          status: window.model.settings.accounts().find((account) => account.id === 'mcp:docs')
            .status,
        };
      }, holding);
      assert.match(seen.href, /^about:blank#slicc-sign-in-[0-9a-f-]{36}$/);
      assert.deepEqual(seen, {
        result: "SLICC couldn't protect the sign-in window. Try again.",
        href: seen.href,
        closed: true,
        asked: 1,
        states: [],
        status: 'disconnected',
      });
    } finally {
      docs.close();
    }
  });
}

test('an MCP sign-in whose window the owner refuses fails at once, even while discovery is still waiting', async (t) => {
  let gate;
  let release;
  const docs = await serve(true, { oauth: { hold: () => gate } });
  try {
    const page = await mcpPage(t, docs);
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = await page.evaluate(async () => {
      window.holding = 'unheld';
      const result = await window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.message
      );
      const popup = window.opens.at(-1);
      return { result, closed: popup.closed, href: popup.location.href };
    });
    assert.match(seen.href, /^about:blank#slicc-sign-in-[0-9a-f-]{36}$/);
    assert.deepEqual(seen, {
      result: "SLICC couldn't protect the sign-in window. Try again.",
      closed: true,
      href: seen.href,
    });
  } finally {
    release?.();
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
    await staged(page, 'the agent', () => window.start('answer=Noted.'));
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

const CALLBACK = 'https://seven.test/oauth/mcp-callback';
const DOCUMENT = 'https://seven.test/oauth/client.json';
const FIXED = `redirect=${encodeURIComponent(CALLBACK)}`;

const relayed = async (t, query) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(fakePopups);
  await page.goto('/');
  await page.evaluate(() =>
    window.write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({
        mcpServers: { docs: { url: 'https://mcp.test/mcp', exposure: 'direct' } },
      })
    )
  );
  await staged(
    page,
    'the agent',
    (q) => window.start(q),
    [
      'relay=mcp.test',
      'vault',
      `oauth=${encodeURIComponent(JSON.stringify({ document: true, registers: false }))}`,
      ...query,
    ].join('&')
  );
  await page.within(
    60000,
    () =>
      window.model.settings
        .accounts()
        .find((account) => account.id === 'mcp:docs' && account.auth === 'oauth')?.status ===
      'disconnected'
  );
  await page.evaluate(() => {
    window.signing = window.model.settings.connect('mcp:docs').then(
      () => 'ok',
      (error) => error.message
    );
    window.authorize = () => {
      const { port1, port2 } = new MessageChannel();
      const url = window.opens.at(-1).location.href;
      const answered = new Promise((resolve) => {
        port1.onmessage = ({ data }) => resolve({ ...data, url });
      });
      window.worker.postMessage({ authorize: { url, port: port2 } }, [port2]);
      return answered;
    };
    window.answer = async (iss) => {
      const { location, url } = await window.authorize();
      const back = new URL(location).searchParams;
      new BroadcastChannel('slicc-mcp-oauth').postMessage({
        code: back.get('code'),
        state: back.get('state'),
        iss: iss ?? back.get('iss'),
      });
      return { url, result: await window.signing };
    };
  });
  await page.within(30000, () => window.opens.at(-1).location.href.includes('/authorize'));
  return page;
};

test('a server that only takes Client ID Metadata Documents shows Sign in, signs in through Settings with the client_id next to the redirect, connects and its tools work', async (t) => {
  const steps = [
    { answer: 'Noted.' },
    { tool: { name: 'mcp__docs__echo', args: { text: 'by document' } } },
    { answer: 'Done.' },
  ].map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`);
  const page = await relayed(t, [FIXED, ...steps]);
  const { url, result } = await page.evaluate(() => window.answer());
  assert.equal(result, 'ok');
  const sent = Object.fromEntries(new URL(url).searchParams);
  assert.equal(sent.client_id, DOCUMENT);
  assert.equal(new URL('client.json', sent.redirect_uri).href, sent.client_id);
  assert.equal(sent.redirect_uri, CALLBACK);
  assert.equal(sent.response_type, 'code');
  assert.equal(sent.code_challenge_method, 'S256');
  assert.equal(sent.scope, 'docs.read');
  assert.equal(sent.resource, 'https://mcp.test/mcp');
  assert.match(sent.state, /^[0-9a-f]{64}$/);
  await page.within(
    60000,
    () =>
      window.model.settings.accounts().find((account) => account.id === 'mcp:docs').status ===
      'connected'
  );
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  await page.evaluate(() => window.agent.send(window.agent.active(), 'Call it.'));
  await page.within(60000, () =>
    window.tools().some((tool) => tool.status === 'done' || tool.status === 'error')
  );
  const seen = await page.evaluate(async () => {
    const { port1, port2 } = new MessageChannel();
    const log = new Promise((resolve) => {
      port1.onmessage = ({ data }) => resolve(data.vault);
    });
    window.worker.postMessage({ upstream: port2 }, [port2]);
    return {
      tools: window.tools().map(({ name, output }) => ({ name, output })),
      grants: (await log).filter((entry) => entry.op === 'grant').map((entry) => entry.oauth),
      state: await window.authorize(),
    };
  });
  assert.deepEqual(seen.tools, [{ name: 'mcp__docs__echo', output: 'echo: by document' }]);
  assert.deepEqual(seen.grants, [
    {
      tokenUrl: 'https://mcp.test/token',
      clientId: DOCUMENT,
      resource: 'https://mcp.test/mcp',
    },
  ]);
  assert.deepEqual(seen.state.clients, []);
  assert.equal(seen.state.issued, 1);
});

test('a Client ID Metadata Document sign-in answered by another issuer exchanges no code', async (t) => {
  const page = await relayed(t, [FIXED, 'answer=Noted.']);
  const { result } = await page.evaluate(() => window.answer('https://other.test'));
  assert.notEqual(result, 'ok');
  const { issued } = await page.evaluate(() => window.authorize());
  assert.equal(issued, 0);
});

const authorizing = () => {
  const { href } = window.opens.at(-1).location;
  return href.includes('/authorize') && href;
};

const WORKER = 'opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist/agent-worker.js';

for (const [at, redirect, client] of [
  [
    `https://www.sliccy.ai/7/${WORKER}`,
    'https://www.sliccy.ai/7/oauth/mcp-callback',
    'https://www.sliccy.ai/7/oauth/client.json',
  ],
  [
    `https://seven.sliccy.ai/${WORKER}`,
    'https://seven.sliccy.ai/oauth/mcp-callback',
    'https://seven.sliccy.ai/oauth/client.json',
  ],
  [
    'https://seven.sliccy.ai/7/agent-worker.js',
    'https://seven.sliccy.ai/oauth/mcp-callback',
    'https://seven.sliccy.ai/oauth/client.json',
  ],
]) {
  test(`a worker at ${at} signs in with its own redirect and the client_id next to it`, async (t) => {
    const page = await relayed(t, [`at=${encodeURIComponent(at)}`, 'answer=Noted.']);
    const sent = new URL(await page.evaluate(() => window.opens.at(-1).location.href)).searchParams;
    assert.equal(sent.get('redirect_uri'), redirect);
    assert.equal(sent.get('client_id'), client);
  });
}

for (const [base, path] of [
  ['/7/opt/agent/node_modules/@ai-ecoverse/slicc-agent/dist-test/', '/7/oauth/mcp-callback'],
  ['/dist-test/', '/oauth/mcp-callback'],
]) {
  test(`a worker served from ${base} registers dynamically with the redirect ${path}`, async (t) => {
    const docs = await serve(true, { oauth: {} });
    try {
      const page = await mcpPage(t, docs, { base });
      const origin = await page.evaluate(() => {
        window.model.settings.connect('mcp:docs').catch(() => undefined);
        return location.origin;
      });
      const sent = new URL(await page.within(30000, authorizing)).searchParams;
      assert.deepEqual(docs.fake.state.oauth.clients[0].redirect_uris, [`${origin}${path}`]);
      assert.equal(sent.get('redirect_uri'), `${origin}${path}`);
    } finally {
      docs.close();
    }
  });
}

for (const [name, second, client, registered] of [
  ['another redirect registers again', 'https://seven.test/7/oauth/mcp-callback', 'client-2', 2],
  ['the same redirect keeps its client', CALLBACK, 'client-1', 1],
]) {
  test(`a stored registration signing in with ${name}`, async (t) => {
    const docs = await serve(true, { oauth: {} });
    try {
      const page = await mcpPage(t, docs, { query: `answer=Noted.&${FIXED}` });
      const signIn = async () => {
        await page.evaluate(() => {
          window.model.settings.connect('mcp:docs').catch(() => undefined);
        });
        return new URL(await page.within(30000, authorizing)).searchParams;
      };
      assert.equal((await signIn()).get('client_id'), 'client-1');
      await page.goto('/');
      await page.within(30000, () => document.readyState === 'complete' && !window.model);
      const query = `answer=Noted.&redirect=${encodeURIComponent(second)}`;
      await page.evaluate((query) => window.start(query, true), query);
      await page.within(60000, () =>
        window.model.settings.accounts().some((account) => account.id === 'mcp:docs')
      );
      const sent = await signIn();
      assert.equal(sent.get('client_id'), client);
      assert.equal(sent.get('redirect_uri'), second);
      assert.equal(docs.fake.state.oauth.clients.length, registered);
      assert.deepEqual(docs.fake.state.oauth.clients.at(-1).redirect_uris, [
        registered === 2 ? second : CALLBACK,
      ]);
    } finally {
      docs.close();
    }
  });
}

const SECURE = `answer=Noted.&${FIXED}`;

for (const [name, oauth, config, client, registered] of [
  ['a registration endpoint registers dynamically', { document: true }, undefined, 'client-1', 1],
  [
    'oauth.clientId comes first',
    { document: true, registers: false },
    { oauth: { clientId: 'fixed' } },
    'fixed',
    0,
  ],
]) {
  test(`an authorization server that takes metadata documents: ${name}`, async (t) => {
    const docs = await serve(true, { oauth });
    try {
      const page = await mcpPage(t, docs, { query: SECURE, config });
      await page.evaluate(() => {
        window.model.settings.connect('mcp:docs').catch(() => undefined);
      });
      const sent = new URL(await page.within(30000, authorizing)).searchParams;
      assert.equal(sent.get('client_id'), client);
      assert.equal(docs.fake.state.oauth.clients.length, registered);
    } finally {
      docs.close();
    }
  });
}

for (const [name, oauth, query] of [
  ['offers no way to get a client', { registers: false }, SECURE],
  ['takes metadata documents, from a page without https', { document: true, registers: false }],
]) {
  test(`an MCP server whose authorization server ${name} is refused clearly before any window opens on it`, async (t) => {
    const docs = await serve(true, { oauth });
    try {
      const page = await mcpPage(t, docs, { query });
      const seen = await page.evaluate(async () => ({
        result: await window.model.settings.connect('mcp:docs').then(
          () => 'ok',
          (error) => error.message
        ),
        href: window.opens.at(-1).location.href,
        status: window.model.settings.accounts().find((account) => account.id === 'mcp:docs')
          .status,
      }));
      assert.match(seen.result, /no dynamic client registration.*oauth\.clientId/);
      assert.match(seen.href, /^about:blank/);
      assert.equal(seen.status, 'disconnected');
      assert.deepEqual(docs.fake.state.oauth.authorizations, []);
      assert.deepEqual(docs.fake.state.oauth.clients, []);
    } finally {
      docs.close();
    }
  });
}

test('an MCP account carries its server URL without the query or fragment, for the page to register with the vault', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate(() =>
    window.write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({
        mcpServers: {
          docs: {
            url: 'https://mcp.test/mcp?v=2#part',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
          },
        },
      })
    )
  );
  await staged(page, 'the agent', () => window.start('relay=mcp.test&vault'));
  await page.within(
    60000,
    () => window.model.settings.accounts().find((account) => account.id === 'mcp:docs')?.url
  );
  const account = await page.evaluate(() =>
    window.model.settings.accounts().find((entry) => entry.id === 'mcp:docs')
  );
  assert.equal(account.url, 'https://mcp.test/mcp');
  assert.equal(account.group, 'mcp');
  assert.equal(account.secret, 'token');
});

async function callback(t, query, name) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.evaluate(
    (query, name) => {
      const state = new URLSearchParams(query).get('state');
      if (name) localStorage.setItem(`slicc-mcp-oauth:${state}`, name);
      window.heard = [];
      new BroadcastChannel('slicc-mcp-oauth').onmessage = ({ data }) => window.heard.push(data);
    },
    query,
    name
  );
  await page.send('Runtime.evaluate', {
    expression: `window.callback = window.open(${JSON.stringify(`/dist/oauth/mcp-callback.html?${query}`)}, 'slicc-mcp-oauth'), null`,
    userGesture: true,
  });
  await page.within(
    30000,
    () =>
      !['signing-in', undefined].includes(
        window.callback.document?.querySelector('main')?.dataset.state
      )
  );
  const shown = await page.evaluate(() => {
    const main = window.callback.document.querySelector('main');
    return {
      state: main.dataset.state,
      title: main.querySelector('h1').textContent,
      text: main.querySelector('p').textContent,
      body: main.textContent,
      search: window.callback.location.search,
    };
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await page.evaluate(() => ({
    closed: window.callback.closed,
    kept: window.callback.closed ? null : window.callback.location.search,
    heard: window.heard,
  }));
  return { ...shown, ...after };
}

test('the MCP callback page keeps a sign-in SLICC never started open with its address intact, hands over nothing and never shows the code', async (t) => {
  const query = 'code=secret-code-123&state=nobody-asked&iss=https%3A%2F%2Fidp.test';
  const seen = await callback(t, query);
  assert.equal(seen.state, 'unknown');
  assert.equal(seen.title, 'No sign-in from SLICC was waiting for this');
  assert.match(seen.text, /SLICC didn't start this sign-in/);
  assert.match(seen.text, /still in the address bar/);
  assert.doesNotMatch(seen.body, /secret-code-123/);
  assert.doesNotMatch(seen.body, /Signed in/);
  assert.deepEqual(
    { search: seen.search, closed: seen.closed, kept: seen.kept, heard: seen.heard },
    { search: `?${query}`, closed: false, kept: `?${query}`, heard: [] }
  );
});

test('the MCP callback page names no sign-in for an error answer SLICC never started', async (t) => {
  const query = 'error=access_denied&error_description=User%20said%20no&state=nobody-asked';
  const seen = await callback(t, query);
  assert.equal(seen.state, 'unknown');
  assert.equal(seen.title, 'No sign-in from SLICC was waiting for this');
  assert.match(seen.text, /^The authorization server answered: User said no\. /);
  assert.doesNotMatch(seen.body, /Couldn't sign in/);
  assert.deepEqual(
    { search: seen.search, closed: seen.closed, kept: seen.kept, heard: seen.heard },
    { search: `?${query}`, closed: false, kept: `?${query}`, heard: [] }
  );
});

test('the MCP callback page hands a sign-in SLICC started back, strips its address and closes', async (t) => {
  const seen = await callback(t, 'code=secret-code-123&state=asked', 'docs');
  assert.deepEqual(
    {
      state: seen.state,
      title: seen.title,
      search: seen.search,
      closed: seen.closed,
      heard: seen.heard,
    },
    {
      state: 'done',
      title: 'Signed in to docs',
      search: '',
      closed: true,
      heard: [{ code: 'secret-code-123', state: 'asked' }],
    }
  );
  assert.doesNotMatch(seen.body, /secret-code-123/);
});

test("an MCP server on the page's own origin is refused clearly, in the file and in Settings, and no request goes there", async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const origin = new URL(chrome.url).origin;
  await page.evaluate(async (origin) => {
    await cookieStore.set('slicc_session', 'dummy-session-0001');
    return window.write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({
        mcpServers: {
          own: { url: `${origin}/own/mcp`, exposure: 'direct' },
          docs: { url: 'https://mcp.test/mcp', exposure: 'direct' },
        },
      })
    );
  }, origin);
  await staged(page, 'the agent', () => window.start('relay=mcp.test&own'));
  await page.within(60000, () => window.account('mcp:docs')?.state === 'connected');
  await page.within(60000, () => window.licks().some((lick) => /"own"/.test(lick.title ?? '')));
  const seen = await page.evaluate(async (origin) => {
    const added = await window.model.settings.addServer('again', { url: `${origin}/own/again` });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return {
      state: window.account('mcp:own')?.state,
      refusals: await window.model.settings.refusals(),
      licks: window
        .licks()
        .filter((lick) => /"own"/.test(lick.title ?? ''))
        .map(({ title, text }) => ({ title, text })),
      added,
      own: await window.own(),
    };
  }, origin);
  const reason = `url is refused. MCP never reaches this page's own origin, ${origin}: a request there would reach SLICC itself`;
  assert.deepEqual(seen.own, []);
  assert.equal(seen.state, 'refused');
  assert.deepEqual(seen.refusals, { own: { code: 'bad-url', reason } });
  assert.deepEqual(seen.licks, [
    { title: 'MCP config problem: server "own", field url', text: reason },
  ]);
  assert.deepEqual(seen.added, { ok: false, code: 'bad-url', reason });
});

test("an MCP server whose sign-in points at the page's own origin is refused there, and no request goes there", async (t) => {
  const origin = new URL(chrome.url).origin;
  const docs = await serve(true, { oauth: { issuer: origin } });
  try {
    const page = await mcpPage(t, docs, { query: 'answer=Noted.&own' });
    const seen = await page.evaluate(async () => {
      await cookieStore.set('slicc_session', 'dummy-session-0001');
      const result = await window.model.settings.connect('mcp:docs').then(
        () => 'ok',
        (error) => error.message
      );
      return { result, own: await window.own() };
    });
    assert.deepEqual(seen.own, []);
    assert.match(seen.result, /MCP never reaches this page's own origin/);
    assert.deepEqual(docs.fake.state.oauth.authorizations, []);
  } finally {
    docs.close();
  }
});

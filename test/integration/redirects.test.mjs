import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const VALUE = 'filled-credential-0001';
const PLACEHOLDER = 'fnox_proxy_docs_key';
const NOTICE = /redirected a request that holds a credential/;

const record = {
  kind: 'mcp',
  name: 'DOCS_KEY',
  server: 'docs',
  placeholder: PLACEHOLDER,
  value: VALUE,
};
const recorded = `record=${encodeURIComponent(JSON.stringify(record))}`;

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
      worker: () =>
        (window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    window.model = createAgentModel(await owner.connect(), { storage: localStorage });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.docs = () => window.model.settings.accounts().find((item) => item.id === 'mcp:docs');
  window.seen = () => {
    const { port1, port2 } = new MessageChannel();
    const answer = new Promise((resolve) => {
      port1.onmessage = ({ data }) => resolve(data.upstream);
    });
    window.worker.postMessage({ upstream: port2 }, [port2]);
    return answer;
  };
  window.said = () =>
    window.agent
      .messages()
      .filter((message) => message.role === 'lick')
      .map((message) => JSON.stringify(message));
};

async function origin(answer) {
  const heard = [];
  const server = createServer(async (request, response) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
    };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    for await (const _ of request);
    heard.push({ path: request.url, headers: request.headers });
    const { status, headers } = answer(request);
    response.writeHead(status, { ...cors, ...headers }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    heard,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}

const heldBy = (entries) => JSON.stringify(entries).includes(VALUE);

for (const [what, header, config, across] of [
  ['another origin', 'x-api-key', { 'x-api-key': '${DOCS_KEY}' }, true],
  ['a path on the same origin', 'authorization', { Authorization: 'Bearer ${DOCS_KEY}' }, false],
]) {
  test(`through the page's fetch, a filled request answered with a redirect to ${what} isn't sent there`, async (t) => {
    const target = await origin(() => ({ status: 200, headers: {} }));
    const server = await origin((request) =>
      request.url === '/mcp'
        ? {
            status: 307,
            headers: { location: across ? `${target.url}/collect` : '/collect' },
          }
        : { status: 200, headers: {} }
    );
    t.after(() => {
      target.close();
      server.close();
    });
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    const url = `${server.url}/mcp`;
    await page.evaluate(
      (text) => window.write('/home/.pi/agent/mcp.json', text),
      JSON.stringify({ mcpServers: { docs: { url, headers: config, exposure: 'direct' } } })
    );
    const query = [
      'vault',
      recorded,
      `vault-mcp=${encodeURIComponent(JSON.stringify([{ server: 'docs', url, names: ['DOCS_KEY'] }]))}`,
    ].join('&');
    await staged(page, 'the agent', (q) => window.start(q, true), query);
    await page.within(60000, () => ['failed', 'connected'].includes(window.docs()?.state));
    assert.deepEqual(
      [...target.heard, ...server.heard].filter((entry) => entry.path === '/collect'),
      []
    );
  });
}

const opened = async (t, url, headers, moved, ...more) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await page.evaluate(
    (text) => window.write('/home/.pi/agent/mcp.json', text),
    JSON.stringify({ mcpServers: { docs: { url, headers, exposure: 'direct' } } })
  );
  const query = [
    'relay=mcp.test',
    'vault',
    recorded,
    `moved=${encodeURIComponent(JSON.stringify(moved))}`,
    ...more,
  ].join('&');
  await staged(page, 'the agent', (q) => window.start(q), query);
  return page;
};

const relayed = async (...args) => {
  const page = await opened(...args);
  await page.within(60000, () => ['failed', 'connected'].includes(window.docs()?.state));
  return page;
};

const AUTH = { Authorization: 'Bearer ${DOCS_KEY}' };

test("a redirect to the server's own URL is prepared by the vault again and the server connects", async (t) => {
  const page = await relayed(t, 'https://mcp.test/api', AUTH, {
    '/api': { status: 307, location: '/api/v2' },
  });
  assert.equal(await page.evaluate(() => window.docs().state), 'connected');
  const requests = await page.evaluate(() => window.seen());
  const [first, second] = requests;
  assert.equal(first.url, 'https://mcp.test/api');
  assert.equal(first.redirect, 'manual');
  assert.equal(second.url, 'https://mcp.test/api/v2');
  assert.equal(second.method, 'POST');
  assert.equal(second.body, first.body);
  assert.equal(second.headers.authorization, `Bearer ${VALUE}`);
});

test("a redirect outside the server's URL is refused by the vault and sends no credential there", async (t) => {
  const page = await relayed(t, 'https://mcp.test/api', AUTH, {
    '/api': { status: 307, location: '/elsewhere' },
  });
  assert.equal(await page.evaluate(() => window.docs().state), 'failed');
  const requests = await page.evaluate(() => window.seen());
  assert.equal(heldBy(requests.filter((item) => item.url.endsWith('/elsewhere'))), false);
  assert.deepEqual(
    requests.filter((item) => item.url.endsWith('/elsewhere')),
    []
  );
});

for (const [what, location] of [
  ['another origin', 'https://other.test/collect'],
  ['plain http on the same host', 'http://mcp.test/api/v2'],
]) {
  test(`a redirect to ${what} is refused with a sentence that names only the origin`, async (t) => {
    const page = await relayed(t, 'https://mcp.test/api?v=held', AUTH, {
      '/api': { status: 308, location },
    });
    await page.within(60000, () => window.said().length > 0);
    const said = (await page.evaluate(() => window.said())).join('\n');
    assert.match(said, NOTICE);
    assert.ok(!said.includes(VALUE));
    assert.ok(!said.includes('v=held'));
    const requests = await page.evaluate(() => window.seen());
    assert.deepEqual(
      requests.map((item) => item.url),
      ['https://mcp.test/api?v=held']
    );
  });
}

test('a redirect loop stops at a fixed number of hops', async (t) => {
  const page = await relayed(t, 'https://mcp.test/api', AUTH, {
    '/api': { status: 307, location: '/api' },
  });
  await page.within(60000, () => window.said().length > 0);
  assert.match((await page.evaluate(() => window.said())).join('\n'), NOTICE);
  assert.equal((await page.evaluate(() => window.seen())).length, 6);
});

for (const [status, method] of [
  [301, 'GET'],
  [302, 'GET'],
  [303, 'GET'],
  [307, 'POST'],
  [308, 'POST'],
]) {
  test(`a POST answered ${status} goes on as ${method}`, async (t) => {
    const page = await opened(t, 'https://mcp.test/api', AUTH, {
      '/api': { status, location: '/api/v2' },
    });
    await page.within(60000, async () => (await window.seen()).length > 1);
    const [first, second] = await page.evaluate(() => window.seen());
    assert.equal(first.method, 'POST');
    assert.equal(second.method, method);
    assert.equal(second.body, method === 'POST' ? first.body : null);
    assert.equal(
      second.headers['content-type'],
      method === 'POST' ? 'application/json' : undefined
    );
  });
}

test('a model request that is redirected to another origin is refused', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const adobe = {
    kind: 'model',
    name: 'ADOBE_IMS_TOKEN',
    provider: 'adobe',
    placeholder: 'fnox_proxy_adobe',
    value: VALUE,
  };
  const query = [
    'relay=mcp.test',
    'e2e',
    'vault',
    `record=${encodeURIComponent(JSON.stringify(adobe))}`,
    `moved=${encodeURIComponent(
      JSON.stringify({
        '/v1/chat/completions': { status: 307, location: 'https://other.test/collect' },
      })
    )}`,
  ].join('&');
  await staged(page, 'the agent', (q) => window.start(q), query);
  await page.within(60000, () =>
    window.model.settings.models().some((model) => model.id === 'adobe/e2e-1')
  );
  await page.evaluate(async () => {
    const { agent } = window;
    agent.setModel(agent.active(), 'adobe/e2e-1');
    await agent.send(agent.active(), 'Hello.');
  });
  await page.within(
    60000,
    () =>
      JSON.stringify(window.agent.messages()).includes('"error"') ||
      JSON.stringify(window.agent.messages()).includes('redirected')
  );
  const said = await page.evaluate(() => JSON.stringify(window.agent.messages()));
  assert.match(said, NOTICE);
  assert.ok(!said.includes(VALUE));
  const requests = await page.evaluate(() => window.seen());
  assert.deepEqual(
    requests.filter((item) => item.url?.includes('other.test')),
    []
  );
});

for (const [what, headers] of [
  ['a filled x-api-key', { 'x-api-key': '${DOCS_KEY}' }],
  ['a filled Authorization', AUTH],
]) {
  test(`a route that doesn't show it won't follow sends nothing for ${what}`, async (t) => {
    const page = await opened(t, 'https://mcp.test/api', headers, {}, 'unproven');
    await page.within(60000, () => window.said().length > 0);
    const said = (await page.evaluate(() => window.said())).join('\n');
    assert.match(said, /can't show it won't follow a redirect/);
    assert.ok(!said.includes(VALUE));
    assert.deepEqual(await page.evaluate(() => window.seen()), []);
  });
}

test('an opaque redirect from the transport is refused', async (t) => {
  const page = await opened(t, 'https://mcp.test/api', AUTH, {
    '/api': { opaque: true },
  });
  await page.within(60000, () => window.said().length > 0);
  assert.match((await page.evaluate(() => window.said())).join('\n'), NOTICE);
  assert.equal((await page.evaluate(() => window.seen())).length, 1);
});

test('with no transport a filled request is refused and nothing is sent', async (t) => {
  const server = await origin(() => ({ status: 200, headers: {} }));
  t.after(() => server.close());
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const url = `${server.url}/mcp`;
  await page.evaluate(
    (text) => window.write('/home/.pi/agent/mcp.json', text),
    JSON.stringify({ mcpServers: { docs: { url, headers: AUTH, exposure: 'direct' } } })
  );
  const query = [
    'vault',
    recorded,
    `vault-mcp=${encodeURIComponent(JSON.stringify([{ server: 'docs', url, names: ['DOCS_KEY'] }]))}`,
  ].join('&');
  await staged(page, 'the agent', (q) => window.start(q), query);
  await page.within(60000, () => window.said().length > 0);
  const said = (await page.evaluate(() => window.said())).join('\n');
  assert.match(said, /can't show it won't follow a redirect/);
  assert.ok(!said.includes(VALUE));
  assert.deepEqual(server.heard, []);
});

test('traits that only look proven send nothing', async (t) => {
  const malformed = { redirectPolicy: 'true', manualRedirects: 1 };
  const page = await opened(
    t,
    'https://mcp.test/api',
    AUTH,
    {},
    `unproven=${encodeURIComponent(JSON.stringify(malformed))}`
  );
  await page.within(60000, () => window.said().length > 0);
  assert.match((await page.evaluate(() => window.said())).join('\n'), /can't show it won't follow/);
  assert.deepEqual(await page.evaluate(() => window.seen()), []);
});

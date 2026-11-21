import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const UNSENT =
  /can't show it won't follow a redirect, so a request that refuses redirects isn't sent/;
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
  window.boot = async (page) => {
    const { bootKernel } = await import('/kernel.js');
    const { fetchTransport } = await import(
      '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
    );
    await import('/dist-test/page.js');
    window.kernel = await bootKernel({}, page ? { network: { transport: fetchTransport() } } : {});
  };
  window.serve = async (files, argv) => {
    for (const [path, text] of Object.entries(files)) await window.write(path, text);
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await window.kernel.connect());
    let out = '';
    const decoder = new TextDecoder();
    return new Promise((resolve) => {
      client.spawn(argv, {
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
          if (out.includes('listening')) resolve(out.trim());
        },
      });
    });
  };
  window.start = async (query) => {
    const owner = await startAgent({
      worker: () =>
        (window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => window.kernel.connect() },
    });
    window.agent = createAgentModel(await owner.connect(), { storage: localStorage }).agent;
    await window.agent.ready();
  };
  window.fetched = (url) =>
    new Promise((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => resolve(data);
      const init = { redirect: 'error', credentials: 'omit' };
      window.worker.postMessage({ fetched: port2, url, init }, [port2]);
    });
  window.seen = () => {
    const { port1, port2 } = new MessageChannel();
    const answer = new Promise((resolve) => {
      port1.onmessage = ({ data }) => resolve(data.upstream.map(({ url }) => url));
    });
    window.worker.postMessage({ upstream: port2 }, [port2]);
    return answer;
  };
};

async function origin() {
  const heard = [];
  const target = { url: '' };
  const server = createServer(async (request, response) => {
    const cors = { 'access-control-allow-origin': '*' };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    for await (const _ of request);
    heard.push(request.url);
    if (request.url === '/away')
      return response.writeHead(307, { ...cors, location: `${target.url}/landed` }).end();
    response.writeHead(200, { ...cors, 'content-type': 'text/plain' }).end('here');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  target.url = `http://127.0.0.1:${server.address().port}`;
  return { heard, url: target.url, close: () => server.close() };
}

const opened = async (t, page, query) => {
  const tab = await chrome.page(t);
  await tab.init(helpers);
  await tab.goto('/');
  await staged(tab, 'the kernel', (p) => window.boot(p), page);
  if (query !== undefined) await staged(tab, 'the agent', (q) => window.start(q), query);
  return tab;
};

for (const [what, page] of [
  ["the page's own fetch", true],
  ["the worker's own fetch, with no transport", false],
]) {
  test(`through ${what}, a redirect: 'error' request that is redirected fails and its next request is never sent`, async (t) => {
    const server = await origin();
    t.after(() => server.close());
    const tab = await opened(t, page, 'answer=Done.');
    const [away, plain] = await tab.evaluate(
      async (url) => [await window.fetched(`${url}/away`), await window.fetched(`${url}/plain`)],
      server.url
    );
    assert.ok(away.error, JSON.stringify(away));
    assert.deepEqual(plain, { status: 200 });
    assert.deepEqual(server.heard, ['/away', '/plain']);
  });
}

const MOVED = { '/away': { status: 307, location: 'https://mcp.test/landed' } };

for (const [what, route, sent] of [
  ['a route that takes the mode', [['follows', '']], true],
  ['a route that hands back the 3xx', [['unproven', { manualRedirects: true }]], true],
  [
    'a route that reports the hops it followed',
    [
      ['follows', ''],
      ['unproven', { manualRedirects: true, redirectHops: true }],
    ],
    false,
  ],
  [
    'a route that follows redirects itself',
    [
      ['follows', ''],
      ['unproven', { manualRedirects: false }],
    ],
    false,
  ],
]) {
  test(`on ${what}, a redirect: 'error' request is ${sent ? 'sent once and fails on the redirect' : 'refused before it is sent'}`, async (t) => {
    const query = new URLSearchParams([
      ['relay', 'mcp.test'],
      ['moved', JSON.stringify(MOVED)],
      ['answer', 'Done.'],
      ...route.map(([name, value]) => [name, value && JSON.stringify(value)]),
    ]).toString();
    const tab = await opened(t, false, query);
    const [away, plain] = await tab.evaluate(async () => [
      await window.fetched('https://mcp.test/away'),
      await window.fetched('https://mcp.test/plain'),
    ]);
    const urls = await tab.evaluate(() => window.seen());
    if (sent) {
      assert.deepEqual(away, { error: 'unexpected redirect' });
      assert.equal(typeof plain.status, 'number', JSON.stringify(plain));
      assert.deepEqual(urls, ['https://mcp.test/away', 'https://mcp.test/plain']);
    } else {
      assert.match(away.error, UNSENT);
      assert.match(plain.error, UNSENT);
      assert.deepEqual(urls, []);
    }
  });
}

test("on a route that answers with a hidden redirect, a redirect: 'error' request fails", async (t) => {
  const query = new URLSearchParams([
    ['relay', 'mcp.test'],
    ['moved', JSON.stringify({ '/away': { opaque: true } })],
    ['unproven', JSON.stringify({ manualRedirects: true, crossOrigin: 'cors' })],
    ['answer', 'Done.'],
  ]).toString();
  const tab = await opened(t, false, query);
  const away = await tab.evaluate(() => window.fetched('https://mcp.test/away'));
  assert.deepEqual(away, { error: 'unexpected redirect' });
  assert.deepEqual(await tab.evaluate(() => window.seen()), ['https://mcp.test/away']);
});

test("on the kernel loopback, a redirect: 'error' request that is redirected fails and its next request is never sent", async (t) => {
  const server = await origin();
  t.after(() => server.close());
  const tab = await opened(t, true);
  const files = {
    '/node_modules/mcp-loop/package.json': manifest,
    '/node_modules/mcp-loop/server.mjs': program,
  };
  const listening = await staged(
    tab,
    'the kernel servers',
    async (files, target) => [
      await window.serve(files, ['mcp-loop', '8820', '', target]),
      await window.serve({}, ['mcp-loop', '8821']),
    ],
    files,
    `${server.url}/landed`
  );
  assert.deepEqual(listening, ['listening 8820', 'listening 8821']);
  await staged(tab, 'the agent', (q) => window.start(q), 'answer=Done.');
  const [away, plain] = await tab.evaluate(async () => [
    await window.fetched('http://8820.kernel.localhost/away'),
    await window.fetched('http://8821.kernel.localhost/plain'),
  ]);
  assert.deepEqual(away, { error: 'unexpected redirect' });
  assert.deepEqual(plain, { status: 404 });
  assert.deepEqual(server.heard, []);
});

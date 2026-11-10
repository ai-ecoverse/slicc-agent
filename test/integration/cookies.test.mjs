import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const VALUE = 'dummy-cookie-value-0001';
const PLACEHOLDER = 'fnox_proxy_docs_key';
const record = {
  kind: 'mcp',
  name: 'DOCS_KEY',
  server: 'docs',
  placeholder: PLACEHOLDER,
  value: VALUE,
};

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
    const kernel = await bootKernel({});
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
  window.asked = (key) => {
    const { port1, port2 } = new MessageChannel();
    const answer = new Promise((resolve) => {
      port1.onmessage = ({ data }) => resolve(data);
    });
    window.worker.postMessage({ [key]: port2 }, [port2]);
    return answer;
  };
};

for (const [what, cookie, sent] of [
  ['a whole placeholder', '${DOCS_KEY}', VALUE],
  ['a named pair', 'fjv3_session=${DOCS_KEY}', `fjv3_session=${VALUE}`],
]) {
  test(`a Cookie header of ${what} reaches the vault's mcp op with its placeholder, and the transport with the value`, async (t) => {
    const page = await chrome.page(t);
    await page.init(helpers);
    await page.goto('/');
    await page.evaluate(
      (text) => window.write('/home/.pi/agent/mcp.json', text),
      JSON.stringify({
        mcpServers: {
          docs: { url: 'https://mcp.test/api', headers: { Cookie: cookie }, exposure: 'direct' },
        },
      })
    );
    const query = [
      'relay=mcp.test',
      'vault',
      `record=${encodeURIComponent(JSON.stringify(record))}`,
      'moved=%7B%7D',
    ].join('&');
    await staged(page, 'the agent', (q) => window.start(q), query);
    await page.within(60000, () =>
      ['failed', 'connected', 'refused'].includes(window.docs()?.state)
    );
    assert.equal(await page.evaluate(() => window.docs().state), 'connected');
    const prepared = await page.evaluate(() => window.asked('vaultMcp'));
    assert.ok(prepared.length);
    for (const headers of prepared)
      assert.ok(
        headers.some(
          ([name, value]) => name === 'cookie' && value === sent.replace(VALUE, PLACEHOLDER)
        ),
        JSON.stringify(headers)
      );
    const { upstream } = await page.evaluate(() => window.asked('upstream'));
    const posts = upstream.filter((item) => item.url === 'https://mcp.test/api');
    assert.ok(posts.length);
    for (const item of posts) assert.equal(item.headers.cookie, sent);
  });
}

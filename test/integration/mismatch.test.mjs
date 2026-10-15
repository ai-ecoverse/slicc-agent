import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a follower of a SLICC on a newer agent shows a banner to update that stays, watches only, and leaves the link', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: Number(env.MISMATCH_WIDTH ?? 1280),
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await page.goto('/');
  const shown = await page.evaluate(async () => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    await import('/dist-test/page.js');
    const { port1, port2 } = new MessageChannel();
    const heard = [];
    port1.onmessage = ({ data }) => heard.push(data);
    port1.postMessage({ hello: `slicc-agent-link/3 ${crypto.randomUUID()}` });
    const connection = await connectAgent(port2);
    const model = createAgentModel(connection, { storage: localStorage });
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    app.model = { ...createDummyModel({ storage: localStorage }), ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    const all = (root, selector, found = []) => {
      found.push(...root.querySelectorAll(selector));
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) all(node.shadowRoot, selector, found);
      return found;
    };
    const banner = find(document, '[data-notice="agent-mismatch"]');
    return {
      mismatch: connection.mismatch,
      notices: model.agent
        .messages('cone')
        .filter((message) => message.kind === 'notice')
        .map((message) => message.text),
      heard: heard.map((frame) =>
        frame instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(frame)) : frame
      ),
      banner: banner?.innerText ?? '',
      closable: Boolean(banner?.querySelector('[data-dismiss]')),
      watch: all(document, '.watch-only').map((node) => node.innerText),
      composers: all(document, 'slicc-composer').length,
      coneActions: all(document, '[data-action="new-cone"], [data-action="delete-cone"]').length,
    };
  });
  assert.match(
    shown.mismatch,
    /newer version of the agent.*Update this SLICC, then reload this page\./
  );
  assert.deepEqual(shown.notices, []);
  assert.deepEqual(shown.heard, [{ t: 'bye', reason: 'link protocol mismatch' }, { close: true }]);
  assert.ok(shown.banner.includes(shown.mismatch), shown.banner);
  assert.equal(shown.closable, false);
  assert.deepEqual(shown.watch, [shown.mismatch]);
  assert.equal(shown.composers, 0);
  assert.equal(shown.coneActions, 0);
  if (env.MISMATCH_SHOT) await page.screenshot(env.MISMATCH_SHOT);
});

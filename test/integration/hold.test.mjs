import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const types = { '.mjs': 'text/javascript' };
const fixtures = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://fixtures').pathname.slice(1);
  const body = /^(fake-vault|scrub)\.mjs$/.test(name)
    ? await readFile(new URL(`./fixtures/${name}`, import.meta.url))
    : null;
  if (!body) return response.writeHead(404).end();
  response
    .writeHead(200, {
      'content-type': types[extname(name)],
      'cross-origin-resource-policy': 'cross-origin',
      'access-control-allow-origin': '*',
    })
    .end(body);
});
await new Promise((resolve) => fixtures.listen(0, '127.0.0.1', resolve));
const origin = `http://localhost:${fixtures.address().port}`;

const chrome = await launch();
after(async () => {
  await chrome.close();
  await new Promise((resolve) => fixtures.close(resolve));
});

test("spectrum's composer shows the vault hold, keeps the cone busy, queues a send and clears", async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await page.goto('/');
  const steps = [
    { tool: { name: 'bash', args: { command: 'echo dummy' } } },
    { answer: 'Done.' },
    { answer: 'Later done.' },
  ];
  await page.evaluate(
    async ({ origin, steps }) => {
      const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
      await import(`${spectrum}/slicc-ui.js`);
      const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
      const { serveVault } = await import(`${origin}/fake-vault.mjs`);
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const channel = new MessageChannel();
      const vault = serveVault(channel.port2, [
        { name: 'DUMMY_TOKEN', value: 'dummy-value-0123456789abcdef', placeholder: 'fnox_dummy' },
      ]);
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      const owner = await startAgent({
        worker: () => {
          const worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
          worker.postMessage({ vault: channel.port1, scrub: vault.pair }, [channel.port1]);
          return worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      const app = document.createElement('slicc-app');
      app.style.cssText = 'display:block;width:1200px;height:800px';
      document.body.style.margin = '0';
      document.body.append(app);
      app.model = { ...createDummyModel({ storage: localStorage }), ...model };
      await customElements.whenDefined('slicc-app');
      await model.agent.ready();
      const holds = [];
      model.agent.on('hold', (hold) => holds.push(hold));
      const lock = (locked) => channel.port2.postMessage({ locked });
      globalThis.holdTest = { owner, connection, model, vault, holds, lock };
    },
    { origin, steps }
  );
  const deep = () => {
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
    globalThis.deep = (selector) => find(document, selector);
  };
  await page.evaluate(deep);
  await page.evaluate(async () => {
    const { model, vault } = globalThis.holdTest;
    vault.pause();
    globalThis.holdTest.first = model.agent.send('cone', 'Run the dummy command.');
  });
  const waiting = await page.until(() => {
    const line = globalThis.deep('slicc-composer')?.shadowRoot?.querySelector('.hold');
    return (
      line && { reason: line.dataset.hold, text: line.textContent.replace(/\s+/g, ' ').trim() }
    );
  });
  assert.equal(waiting.reason, 'waiting');
  assert.match(waiting.text, /^Waiting for the vault( · \d+ tool results? held)?$/);
  const queued = await page.evaluate(async () => {
    const { model } = globalThis.holdTest;
    const busy = model.agent.busy('cone');
    globalThis.holdTest.second = model.agent.send('cone', {
      text: 'Then this, later.',
      mode: 'queue',
    });
    return { busy, hold: model.agent.hold() };
  });
  assert.equal(queued.busy, true);
  assert.equal(queued.hold.reason, 'waiting');
  const shown = await page.until(() => {
    const composer = globalThis.deep('slicc-composer')?.shadowRoot;
    const item = composer?.querySelector('.queue li.queued');
    return item?.textContent.includes('Then this, later.') && item.textContent.trim();
  });
  assert.match(shown, /Then this, later\./);
  await page.evaluate(() => globalThis.holdTest.lock('passkey'));
  const locked = await page.until(() => {
    const line = globalThis.deep('slicc-composer')?.shadowRoot?.querySelector('.hold');
    return line?.dataset.hold === 'locked' && line.textContent.replace(/\s+/g, ' ').trim();
  });
  assert.match(locked, /^Unlock the vault to continue · \d+ tool results? held$/);
  if (env.HOLD_SHOT) await page.screenshot(env.HOLD_SHOT);
  const cleared = await page.evaluate(async () => {
    const { model, vault, holds, lock, connection, owner } = globalThis.holdTest;
    lock('no');
    vault.resume();
    await globalThis.holdTest.first;
    await globalThis.holdTest.second;
    const until = async (check) => {
      for (let n = 0; n < 300 && !check(); n++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return check();
    };
    await until(() => model.agent.hold() === null);
    await until(
      () =>
        !globalThis.deep('slicc-composer')?.shadowRoot?.querySelector('.hold') &&
        connection.transcript.value.entries.some(
          (entry) =>
            entry.kind === 'pi.assistant' && JSON.stringify(entry.model).includes('Later done.')
        )
    );
    const result = {
      line: Boolean(globalThis.deep('slicc-composer')?.shadowRoot?.querySelector('.hold')),
      hold: model.agent.hold(),
      last: holds.at(-1),
      reasons: holds.map((hold) => hold?.reason ?? null),
      texts: model.agent
        .messages('cone')
        .map((message) => message.parts?.[0]?.text ?? message.text),
    };
    await owner.release();
    return result;
  });
  assert.equal(cleared.line, false);
  assert.equal(cleared.hold, null);
  assert.equal(cleared.last, null);
  assert.ok(cleared.reasons.includes('waiting'));
  assert.ok(cleared.reasons.includes('locked'));
  assert.ok(cleared.texts.includes('Then this, later.'));
  assert.ok(cleared.texts.includes('Later done.'));
});

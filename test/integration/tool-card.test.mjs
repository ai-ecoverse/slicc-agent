import assert from 'node:assert/strict';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const failing = 'panel open files --left chat';
const inner = 'ls /nope; echo listed';
const killed = 'echo going; kill -TERM $$';
const long = `l=$(printf '%0240d' 0); for i in $(seq 1 2400); do echo "dummy line $i $l"; done`;

const views = [
  { name: 'light-1280', width: 1280, height: 860, scheme: 'light' },
  { name: 'dark-1280', width: 1280, height: 860, scheme: 'dark' },
  { name: 'light-420', width: 420, height: 860, scheme: 'light' },
];

test('a bash card shows no harness block, its exit as a badge and its failed programs as metadata, not notes', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    { tool: { name: 'bash', args: { command: failing } } },
    { tool: { name: 'bash', args: { command: long } } },
    { tool: { name: 'bash', args: { command: inner } } },
    { tool: { name: 'bash', args: { command: killed } } },
    { answer: 'Done.' },
  ];
  await staged(
    page,
    'a failed bash card shows',
    async (steps) => {
      const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
      await import(`${spectrum}/slicc-ui.js`);
      const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const refuse = async () => ({
        stdout: '',
        stderr: 'panel: files cannot open on the left of chat in this layout\n',
        code: 5,
      });
      const model = createAgentModel(await owner.connect(), {
        storage: localStorage,
        page: { tab: 'A', run: refuse },
      });
      const app = document.createElement('slicc-app');
      app.style.cssText = 'display:block;width:100vw;height:100vh';
      document.body.style.margin = '0';
      document.body.append(app);
      app.model = { ...createDummyModel({ storage: localStorage }), ...model };
      await customElements.whenDefined('slicc-app');
      await model.agent.ready();
      await model.agent.send('cone', 'Open the files panel, then print a long dummy listing.');
      const find = (root, selector) => {
        const found = [...root.querySelectorAll(selector)];
        for (const node of root.querySelectorAll('*'))
          if (node.shadowRoot) found.push(...find(node.shadowRoot, selector));
        return found;
      };
      const text = (root) =>
        [...root.childNodes]
          .map((node) =>
            node.nodeType === Node.TEXT_NODE
              ? node.textContent
              : `${node.shadowRoot ? text(node.shadowRoot) : ''}${text(node)}`
          )
          .join('');
      globalThis.cardTest = { model, find, text, owner };
    },
    steps
  );
  const seen = await page.until(() => {
    const { model, find, text } = globalThis.cardTest;
    const tools = model.agent
      .messages('cone')
      .flatMap((message) => (message.role === 'assistant' ? message.parts : []))
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool);
    const done = model.agent.messages('cone').some((m) => m.parts?.some((p) => p.text === 'Done.'));
    if (!done || tools.length < 4) return null;
    const shown = (node) => node.textContent.replace(/\s+/g, ' ').trim();
    const notes = find(document, '[data-note]').map((node) => ({
      severity: node.dataset.severity,
      text: shown(node),
    }));
    const exits = find(document, 'swc-badge[data-exit]').map((node) => ({
      exit: node.dataset.exit,
      signal: node.dataset.signal ?? null,
      variant: node.getAttribute('variant'),
      text: shown(node),
    }));
    const programs = find(document, '[data-program]').map(shown);
    return { tools, page: text(document.body), notes, exits, programs };
  });
  const [refused, listing, listed, signalled] = seen.tools;
  assert.equal(refused.status, 'error');
  assert.match(refused.output, /cannot open on the left/);
  assert.doesNotMatch(refused.output, /harness/);
  assert.equal(refused.notes, undefined);
  assert.deepEqual(refused.exit, { code: 5 });
  assert.deepEqual(listing.exit, { code: 0 });
  assert.equal(listed.status, 'done');
  assert.deepEqual(listed.exit, { code: 0 });
  assert.deepEqual(listed.programs, [{ name: 'ls', code: 2 }]);
  assert.equal(listed.notes, undefined);
  assert.equal(signalled.status, 'error');
  assert.deepEqual(signalled.exit, { code: 143, signal: 'SIGTERM' });
  assert.equal(signalled.notes, undefined);
  assert.doesNotMatch(listing.output, /<\/?harness>/);
  assert.ok(
    listing.notes.some((note) => note.severity === 'info' && /^Full output in /.test(note.text))
  );
  assert.doesNotMatch(seen.page, /<\/?harness>/);
  assert.deepEqual(
    seen.notes.map((note) => note.severity),
    ['warn', 'info']
  );
  assert.match(
    seen.notes[0].text,
    /^Warning: Output truncated: [\d,]+ lines and [\d,]+ bytes dropped from the start$/
  );
  assert.equal(seen.notes[1].text, `Note: ${listing.notes[1].text}`);
  assert.deepEqual(seen.exits, [
    { exit: '5', signal: null, variant: 'negative', text: 'Exit 5' },
    { exit: '0', signal: null, variant: 'positive', text: 'Exit 0' },
    { exit: '0', signal: null, variant: 'positive', text: 'Exit 0' },
    { exit: '143', signal: 'SIGTERM', variant: 'negative', text: 'Killed (SIGTERM)' },
  ]);
  assert.deepEqual(seen.programs, ['ls exited 2']);
  assert.doesNotMatch(seen.page, /Exited with code/);
  const model = await staged(page, 'a failed bash card shows', async () => {
    const entries = await globalThis.cardTest.owner
      .connect()
      .then((c) => c.transcript.value.entries);
    return entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((block) => block.text ?? '').join(''));
  });
  assert.match(model[0], /<harness>\n\[error\] Command exited with code 5\n<\/harness>$/);
  if (!env.CARD_SHOTS) return;
  for (const view of views) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: view.scheme }],
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    await page.evaluate(() => {
      for (const status of globalThis.cardTest.find(document, '[data-action="open-cluster"]'))
        if (!status.hasAttribute('open')) status.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.evaluate(() => {
      for (const toggle of globalThis.cardTest.find(document, '.run-toggle'))
        if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const opened = await page.evaluate(() =>
      globalThis.cardTest
        .find(document, '.run-toggle')
        .map((toggle) => toggle.getAttribute('aria-expanded'))
    );
    assert.deepEqual(opened, ['true', 'true', 'true', 'true']);
    for (const [part, block] of [
      ['top', 'start'],
      ['tail', 'end'],
      ['exits', 'end'],
    ]) {
      await page.evaluate(
        ({ part, block }) => {
          const steps = globalThis.cardTest.find(document, '.run-detail');
          const target = {
            top: steps[0],
            tail: steps[1].querySelector('[data-note]'),
            exits: steps[3],
          }[part];
          target.scrollIntoView({ block });
          window.scrollTo(0, 0);
        },
        { part, block }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.screenshot(`${env.CARD_SHOTS}/tool-card-${view.name}-${part}.png`);
    }
  }
});

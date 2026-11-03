import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a conversation stored with a copied extension list gets a built-in it lacked after a boot, also forked, in a new chat and frozen then thawed, while a deliberate removal and tool choice stay', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the copied extension list', async () => {
    await import('/dist-test/page.js');
    stage('the seeded store');
    const directory = `/.slicc/selection-${Date.now()}`;
    const seeded = await new Promise((resolve) => {
      const worker = new Worker(
        `/dist-test/legacy-worker.js?directory=${directory}&without=slicc-images`,
        {
          type: 'module',
        }
      );
      worker.onmessage = ({ data }) => {
        worker.terminate();
        resolve(data);
      };
    });
    if (seeded.error) throw new Error(seeded.error);
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    const canvas = new OffscreenCanvas(2400, 60);
    canvas.getContext('2d').fillRect(0, 0, 2400, 60);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await client.fs.writeFile('/tmp/wide.png', new Uint8Array(await blob.arrayBuffer()));
    await client.fs.mkdir('/home/.pi/agent', { recursive: true });
    await client.fs.writeFile('/home/.pi/agent/settings.json', '{"memory":{"extract":false}}');
    const read = { tool: { name: 'read', args: { path: '/tmp/wide.png' } } };
    const steps = [
      read,
      { answer: 'Old.' },
      read,
      { answer: 'Kept.' },
      { tool: { name: 'bash', args: { command: 'echo hi' } } },
      { answer: 'Kept bash.' },
      read,
      { answer: 'Forked.' },
      read,
      { answer: 'Fresh.' },
      read,
      { answer: 'Thawed.' },
      read,
      { answer: 'Kept fresh.' },
    ];
    const params = new URLSearchParams([
      ['persist', directory],
      ...steps.map((step) => ['step', JSON.stringify(step)]),
    ]);
    stage('the agent');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const ctx = BACKGROUND_CONTEXT;
    const shown = (agentId) => Boolean(connection.views.value?.[agentId]);
    const entries = (agentId) => connection.views.value?.[agentId]?.entries ?? [];
    const results = (agentId) =>
      entries(agentId)
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) =>
          (entry.model?.[0]?.content ?? [])
            .map((block) => block.text ?? '')
            .join('')
            .trim()
        );
    const until = (check, what) => when([connection.views], check, what);
    const run = async (agentId, text) => {
      const before = results(agentId).length;
      stage(`${text} in ${agentId}`);
      const sent = await connection.control.send(
        { text, whenBusy: 'followUp', requestId: null, agentId },
        ctx
      );
      await connection.control.wait(sent.submissionId, ctx);
      return until(() => results(agentId).at(before), `the result in ${agentId}`);
    };
    await until(() => entries('cone').length && shown(seeded.kept), 'both cones');
    const out = {};
    out.old = await run('cone', 'Read it.');
    out.kept = await run(seeded.kept, 'Read it.');
    out.keptBash = await run(seeded.kept, 'Run it.');
    const answers = entries('cone').filter((entry) => entry.kind === 'pi.assistant');
    const rewound = await connection.control.rewindAgent('cone', `e${answers[1].id}`, ctx);
    out.rewound = rewound.done;
    await until(() => entries('cone').some((entry) => entry.kind === 'slicc.rewound'), 'the fork');
    out.forked = await run('cone', 'Read it.');
    await connection.control.newChat('cone', ctx);
    await until(() => !entries('cone').some((entry) => entry.kind === 'pi.user'), 'the new chat');
    out.fresh = await run('cone', 'Read it.');
    const frozen = await connection.control.freeze('cone', ctx);
    await until(() => !shown('cone'), 'the frozen cone');
    await connection.control.thaw(frozen.id, ctx);
    await until(() => shown('cone'), 'the thawed cone');
    out.thawed = await run('cone', 'Read it.');
    await connection.control.newChat(seeded.kept, ctx);
    await until(
      () => !entries(seeded.kept).some((entry) => entry.kind === 'pi.user'),
      'the kept new chat'
    );
    out.keptFresh = await run(seeded.kept, 'Read it.');
    await owner.release();
    return out;
  });
  const image = /\/tmp\/wide\.png \(image\/(png|jpeg), \d+ bytes\)/;
  assert.match(seen.old, image);
  assert.doesNotMatch(seen.kept, image);
  assert.doesNotMatch(seen.kept, /not available/);
  assert.match(seen.keptBash, /Tool bash is not available/);
  assert.equal(seen.rewound, true);
  assert.match(seen.forked, image);
  assert.match(seen.fresh, image);
  assert.match(seen.thawed, image);
  assert.doesNotMatch(seen.keptFresh, image);
  assert.doesNotMatch(seen.keptFresh, /not available/);
});

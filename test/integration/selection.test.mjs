import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a conversation stored with a copied extension list gets a built-in it lacked after a boot, also forked, in a new chat and frozen then thawed, while a deliberate removal and tool choice stay', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const directory = `/.slicc/selection-${Date.now()}`;
    const seeded = await new Promise((resolve) => {
      const worker = new Worker(`/dist-test/legacy-worker.js?directory=${directory}`, {
        type: 'module',
      });
      worker.onmessage = ({ data }) => {
        worker.terminate();
        resolve(data);
      };
    });
    if (seeded.error) throw new Error(seeded.error);
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    let pnpm = '';
    const probe = await client.spawn(['bash', '-c', 'printf %s "$PNPM_HOME"'], {
      cwd: '/',
      onStdout: (bytes) => {
        pnpm += new TextDecoder().decode(bytes);
      },
    });
    await probe.exited;
    const bin = `${pnpm || '/home/.local/share/pnpm'}/bin`;
    await client.fs.mkdir(bin, { recursive: true });
    await client.fs.writeFile(`${bin}/playwright-cli`, '#!/bin/bash\necho "opened $*"\n');
    const open = `chmod +x ${bin}/playwright-cli && playwright-cli open ${location.origin}/home/x.html`;
    const bash = { tool: { name: 'bash', args: { command: open } } };
    const steps = [
      bash,
      { answer: 'Old.' },
      bash,
      { answer: 'Kept.' },
      { tool: { name: 'read', args: { path: '/etc/hostname' } } },
      { answer: 'Kept read.' },
      bash,
      { answer: 'Forked.' },
      bash,
      { answer: 'Fresh.' },
      bash,
      { answer: 'Thawed.' },
      bash,
      { answer: 'Kept fresh.' },
    ];
    const params = new URLSearchParams([
      ['persist', directory],
      ...steps.map((step) => ['step', JSON.stringify(step)]),
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const ctx = BACKGROUND_CONTEXT;
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
    const until = async (check, what) => {
      for (let i = 0; i < 400; i++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const run = async (agentId, text) => {
      const before = results(agentId).length;
      const sent = await connection.control.send(
        { text, whenBusy: 'followUp', requestId: null, agentId },
        ctx
      );
      await connection.control.wait(sent.submissionId, ctx);
      return until(() => results(agentId).at(before), `the result in ${agentId}`);
    };
    await until(() => entries('cone').length && entries(seeded.kept).length, 'both cones');
    const out = {};
    out.old = await run('cone', 'Open it.');
    out.kept = await run(seeded.kept, 'Open it.');
    out.keptRead = await run(seeded.kept, 'Read it.');
    const answers = entries('cone').filter((entry) => entry.kind === 'pi.assistant');
    const rewound = await connection.control.rewindAgent('cone', `e${answers[1].id}`, ctx);
    out.rewound = rewound.done;
    await until(() => entries('cone').some((entry) => entry.kind === 'slicc.rewound'), 'the fork');
    out.forked = await run('cone', 'Open it.');
    await connection.control.newChat('cone', ctx);
    await until(() => !entries('cone').some((entry) => entry.kind === 'pi.user'), 'the new chat');
    out.fresh = await run('cone', 'Open it.');
    const frozen = await connection.control.freeze('cone', ctx);
    await connection.control.thaw(frozen.id, ctx);
    await until(() => entries('cone').length, 'the thawed cone');
    out.thawed = await run('cone', 'Open it.');
    await connection.control.newChat(seeded.kept, ctx);
    await until(
      () => !entries(seeded.kept).some((entry) => entry.kind === 'pi.user'),
      'the kept new chat'
    );
    out.keptFresh = await run(seeded.kept, 'Open it.');
    await owner.release();
    return out;
  });
  const refusal = /SLICC's own pages can't be opened or driven from the browser tools\./;
  assert.match(seen.old, refusal);
  assert.doesNotMatch(seen.old, /opened open/);
  assert.match(seen.kept, /^opened open /);
  assert.match(seen.keptRead, /Tool read is not available/);
  assert.equal(seen.rewound, true);
  assert.match(seen.forked, refusal);
  assert.match(seen.fresh, refusal);
  assert.match(seen.thawed, refusal);
  assert.match(seen.keptFresh, /^opened open /);
});

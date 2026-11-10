import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('scrub state: legacy stale welcome and equal-version updates cannot disable tool-output protection', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'legacy monotonic scrub state', async () => {
    await import('/dist-test/page.js');
    const { fakeVault } = await import('/dist-test/scrub-receipts.js');
    const { bootKernel } = await import('/kernel.js');
    stage('the kernel');
    const kernel = await bootKernel();
    const value = 'fake-legacy-receipt-value';
    const placeholder = 'fnox_proxy_000000000000000000000002';
    const fake = fakeVault([{ name: 'LEGACY_TOKEN', value, placeholder }], 7);
    const params = new URLSearchParams([
      [
        'step',
        JSON.stringify({
          tool: { name: 'bash', args: { command: "printf '%s' fake-legacy- receipt-value" } },
        }),
      ],
      ['step', JSON.stringify({ answer: 'Done.' })],
    ]);
    let worker;
    stage('the agent');
    const owner = await startAgent({
      worker: () => {
        worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
        worker.postMessage({ vault: fake.port, scrub: fake.pair }, [fake.port]);
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    await when([connection.vault], () => connection.vault.value.version === 7, 'initial pair');
    fake.welcome({ scrub: { needed: false, version: 6 }, locked: true });
    await when([connection.vault], () => connection.vault.value.locked === 'passkey', 'welcome');
    fake.publish({ needed: false, version: 7 });
    fake.welcome({ locked: false });
    await when([connection.vault], () => connection.vault.value.locked === 'no', 'unlock');
    const answer = await connection.prompt('Run the legacy probe.');
    const result = {
      answer,
      state: connection.vault.value,
      entries: JSON.stringify(connection.transcript.value.entries),
      docs: JSON.stringify(connection.transcript.value.docs),
      value,
      placeholder,
    };
    await owner.release();
    return result;
  });
  assert.equal(seen.answer, 'Done.');
  assert.ok(!seen.entries.includes(seen.value), 'tool output must not retain the fake value');
  assert.ok(!seen.docs.includes(seen.value));
  assert.ok(seen.entries.includes(seen.placeholder));
  assert.equal(seen.state.version, 7);
  assert.equal(seen.state.needed, true);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.receipt = (worker, scrub, nonce = crypto.randomUUID().replaceAll('-', '')) => {
    const { port1, port2 } = new MessageChannel();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        port1.close();
        reject(new Error('Scrub receipt timed out'));
      }, 2000);
      port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        port1.close();
        resolve({ expected: { v: 1, nonce, version: scrub.version }, actual: data });
      };
      worker.postMessage({ scrub, scrubReceipt: { v: 1, nonce, version: scrub.version } }, [port2]);
    });
  };
  window.boot = async (steps = []) => {
    await import('/dist-test/page.js');
    const { fakeVault } = await import('/dist-test/scrub-receipts.js');
    const { bootKernel } = await import('/kernel.js');
    stage('the kernel');
    const kernel = await bootKernel();
    const fake = fakeVault([], 0);
    const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
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
    const inspect = (key) => {
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve) => {
        port1.onmessage = ({ data }) => {
          port1.close();
          resolve(data);
        };
        worker.postMessage({ [key]: port2 }, [port2]);
      });
    };
    return { owner, worker, fake, connection, inspect, fakeVault };
  };
};

test('scrub receipts: an empty vault installs protection before receipt and immediate tool stdout, despite a late stale welcome and reconnect', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const value = 'fake-receipt-access-value-001';
  const placeholder = 'fnox_proxy_000000000000000000000001';
  const seen = await staged(
    page,
    'receipt before tool output',
    async ({ value, placeholder }) => {
      const steps = [
        { tool: { name: 'bash', args: { command: "printf '%s' fake-receipt- access-value-001" } } },
        { answer: 'Scrubbed.' },
      ];
      const { owner, worker, fake, connection, inspect, fakeVault } = await boot(steps);
      const initial = { ...connection.vault.value };
      fake.add({ kind: 'secret', name: 'RECEIPT_TOKEN', value, placeholder });
      const installed = await receipt(worker, { needed: true, version: 1, ready: true });
      stage('the stale welcome');
      fake.welcome({ scrub: { needed: false, version: 0 }, locked: true });
      await when([connection.vault], () => connection.vault.value.locked === 'passkey', 'welcome');
      const afterWelcome = { ...connection.vault.value };
      fake.publish({ needed: false, version: 0 });
      fake.welcome({ scrub: null, locked: false });
      await when([connection.vault], () => connection.vault.value.locked === 'no', 'unlock');
      const replacement = fakeVault([{ name: 'RECEIPT_TOKEN', value, placeholder }], 0);
      worker.postMessage({ vault: replacement.port, scrub: null }, [replacement.port]);
      const older = await receipt(worker, { needed: false, version: 0 });
      worker.postMessage({ scrub: { needed: false, version: 1 } });
      stage('immediate fake credential stdout');
      const answer = await connection.prompt('Run the probe.');
      const result = {
        initial,
        installed,
        older,
        afterWelcome,
        answer,
        state: connection.vault.value,
        entries: JSON.stringify(connection.transcript.value.entries),
        docs: JSON.stringify(connection.transcript.value.docs),
        requests: await inspect('requests'),
        logged: await inspect('logged'),
        ops: replacement.log.map(({ op }) => op),
      };
      await owner.release();
      return result;
    },
    { value, placeholder }
  );
  assert.equal(seen.initial.needed, false);
  assert.equal(seen.initial.version, 0);
  assert.deepEqual(seen.installed.actual, seen.installed.expected);
  assert.deepEqual(seen.older.actual, seen.older.expected);
  assert.equal(seen.afterWelcome.version, 1);
  assert.equal(seen.afterWelcome.needed, true);
  assert.equal(seen.state.version, 1);
  assert.equal(seen.state.needed, true);
  assert.equal(seen.answer, 'Scrubbed.');
  assert.ok(seen.ops.includes('redactStream'));
  assert.ok(seen.ops.includes('redact'));
  assert.ok(seen.entries.includes(placeholder));
  assert.ok(seen.requests.some((request) => request.includes(placeholder)));
  for (const text of [seen.entries, seen.docs, ...seen.requests, ...seen.logged]) {
    assert.ok(!text.includes(value));
    assert.ok(!text.includes(seen.installed.expected.nonce));
  }
});

test('scrub receipts: malformed requests never acknowledge or downgrade, and ready false and strictly newer empty pairs remain valid', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'strict private receipts', async () => {
    const { owner, worker, connection, inspect } = await boot();
    const valid = await receipt(worker, { needed: true, version: 7, ready: false });
    const nonce = '0123456789abcdef0123456789abcdef';
    const pair = { needed: false, version: 8, ready: true };
    const receiptValue = { v: 1, nonce, version: 8 };
    const cases = [
      { scrubReceipt: null },
      { scrubReceipt: [] },
      { scrubReceipt: { ...receiptValue, v: 2 } },
      { scrubReceipt: { ...receiptValue, nonce: nonce.toUpperCase() } },
      { scrubReceipt: { ...receiptValue, nonce: `${nonce}0` } },
      { scrubReceipt: { ...receiptValue, nonce: 1 } },
      { scrubReceipt: { ...receiptValue, extra: true } },
      { scrubReceipt: { v: 1, nonce } },
      { scrubReceipt: { ...receiptValue, version: 9 } },
      { scrubReceipt: { ...receiptValue, version: -1 } },
      { scrubReceipt: { ...receiptValue, version: Number.MAX_SAFE_INTEGER + 1 } },
      { scrub: null },
      { scrub: [] },
      { scrub: { version: 8 } },
      { scrub: { ...pair, needed: 0 } },
      { scrub: { ...pair, ready: 'yes' } },
      { scrub: { ...pair, version: Number.NaN } },
      { scrub: { ...pair, version: Number.POSITIVE_INFINITY } },
      { scrub: { ...pair, version: -1 } },
      { scrub: { ...pair, version: 8.5 } },
      { scrub: { ...pair, version: Number.MAX_SAFE_INTEGER + 1 } },
      { locked: false },
    ];
    const acknowledgements = [];
    const channels = [];
    for (const [index, item] of [...cases, {}, {}].entries()) {
      const count = index === cases.length ? 0 : index === cases.length + 1 ? 2 : 1;
      const ports = Array.from({ length: count }, () => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => acknowledgements.push({ index, data });
        channels.push(channel.port1);
        return channel.port2;
      });
      worker.postMessage({ scrub: pair, scrubReceipt: receiptValue, ...item }, ports);
    }
    worker.postMessage({ scrub: { needed: false, version: 7 } });
    worker.postMessage({ scrub: { needed: false, version: 6 } });
    await inspect('requests');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const held = { ...connection.vault.value };
    const newer = await receipt(worker, { needed: false, version: 9, ready: true });
    await when([connection.vault], () => connection.vault.value.version === 9, 'new empty state');
    const empty = { ...connection.vault.value };
    for (const port of channels) port.close();
    await owner.release();
    return { valid, acknowledgements, held, newer, empty };
  });
  assert.deepEqual(seen.valid.actual, seen.valid.expected);
  assert.deepEqual(seen.acknowledgements, []);
  assert.equal(seen.held.version, 7);
  assert.equal(seen.held.needed, true);
  assert.deepEqual(seen.newer.actual, seen.newer.expected);
  assert.equal(seen.empty.version, 9);
  assert.equal(seen.empty.needed, false);
});

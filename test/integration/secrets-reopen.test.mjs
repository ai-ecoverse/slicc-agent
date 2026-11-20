import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';
import { proxyId } from './fixtures/seeds.mjs';

const chrome = await launch();
after(() => chrome.close());

const KNOWN = {
  name: 'KNOWN_TOKEN',
  value: 'known-value-0123456789abcdef',
  placeholder: proxyId(80),
};
const FRESH = 'fresh-sealed-q1w2e3r4t5y6u7i8o9';
const SECOND = 'second-sealed-z9x8c7v6b5n4m3l2';
const OTHER = {
  name: 'OTHER_TOKEN',
  value: 'other-process-p0o9i8u7y6t5r4e3',
  placeholder: proxyId(81),
};
const CHANGED = "the vault's values changed; open the stream again and push from its start";
const split = (value) => (value.match(/.{1,10}/gu) ?? []).map((part) => `'${part}'`).join('');
const MARK = 'sealed placeholder MARK >/dev/null 2>&1';

const helpers = () => {
  window.run = async ({ known, other, command, typed, plan, changed, fnox, config }) => {
    if (fnox) {
      let dir = await navigator.storage.getDirectory();
      for (const part of ['etc', 'fnox'])
        dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle('config.toml', { create: true });
      const writable = await file.createWritable();
      await writable.write(config);
      await writable.close();
    }
    await import('/dist-test/page.js');
    const { fakeVault } = await import('/dist-test/scrub-receipts.js');
    const { bootKernel } = await import('/kernel.js');
    const fake = fakeVault([known], 1);
    const sealed = [];
    const hook = fakeSealed(sealed, [], typed);
    const acts = {
      hold: () => fake.pause(['push', 'end']),
      release: () => fake.resume(),
      refuse: () => fake.fail('redactStream', 'EACCES', 'unlock the vault to continue'),
      again: () => fake.fail('push', 'EAGAIN', changed),
      other: () => {
        fake.add(other);
        fake.publish({ needed: true, version: fake.version });
      },
      seal: (request) => {
        const found = sealed.find((item) => item.name === request.name);
        fake.add({ name: found.name, value: found.value, placeholder: found.placeholder });
        fake.publish({ needed: true, version: fake.version });
      },
    };
    const kernel = await bootKernel(
      fnox ? { 'node_modules/@ai-ecoverse/wasi-fnox/': ['package.json', 'bin/fnox.wasm'] } : {},
      {
        ...(fnox ? { env: { FNOX_CONFIG_DIR: '/etc/fnox' } } : {}),
        sealed: async (request) => {
          const reply = await hook(request);
          for (const act of plan[`${request.op} ${request.name}`] ?? []) acts[act](request);
          return reply;
        },
      }
    );
    const steps = [{ tool: { name: 'bash', args: { command } } }, { answer: 'Done.' }];
    const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
    let worker;
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
        port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ [key]: port2 }, [port2]);
      });
    };
    stage('the run');
    const answer = await connection.prompt('Go.').catch((error) => `failed: ${error.message}`);
    const result = {
      answer,
      placeholders: Object.fromEntries(sealed.map((item) => [item.name, item.placeholder])),
      entries: JSON.stringify(connection.transcript.value.entries),
      results: connection.transcript.value.entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .flatMap((entry) => entry.model.flatMap((message) => message.content))
        .map((part) => part.text),
      docs: JSON.stringify(connection.transcript.value.docs),
      requests: await inspect('requests'),
      logged: await inspect('logged'),
      ops: fake.log.map(({ op }) => op),
      errors: fake.errors.map(({ op, code }) => `${op} ${code}`),
    };
    await owner.release();
    return result;
  };
};

async function ran(t, label, options) {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  return staged(page, label, (given) => window.run(given), {
    known: KNOWN,
    other: OTHER,
    typed: {},
    changed: CHANGED,
    ...options,
  });
}

function clean(seen, values) {
  for (const text of [seen.entries, seen.docs, ...seen.requests, ...seen.logged])
    for (const value of [KNOWN.value, ...values]) assert.ok(!text.includes(value), text);
}

test('scrub reopen: a value the command seals mid-run is scrubbed from output it printed before, still held, and after', async (t) => {
  const command = [
    MARK,
    `printf 'before=%s\\n' ${split(FRESH)}`,
    `printf 'known=%s\\n' ${split(KNOWN.value)}`,
    'V=$(sealed ask FRESH_TOKEN --reveal)',
    'echo "after=$V"',
    'echo end',
  ].join('; ');
  const seen = await ran(t, 'a value sealed by the command', {
    command,
    typed: { FRESH_TOKEN: FRESH },
    plan: { 'placeholder MARK': ['hold'], 'ask FRESH_TOKEN': ['seal', 'release'] },
  });
  clean(seen, [FRESH]);
  assert.equal(seen.answer, 'Done.');
  const fresh = seen.placeholders.FRESH_TOKEN;
  assert.match(fresh, /^fnox_proxy_/);
  assert.deepEqual(seen.results, [
    `before=${fresh}\nknown=${KNOWN.placeholder}\nafter=${fresh}\nend\n`,
  ]);
  assert.ok(seen.errors.includes('push EAGAIN'), seen.errors.join());
  assert.ok(seen.ops.filter((op) => op === 'redactStream').length >= 2, seen.ops.join());
});

test('scrub reopen: fnox set --ask seals a value mid-command, and the command still exits 0 with its output scrubbed', async (t) => {
  const command = [
    'echo start',
    'P=$(fnox set FRESH_TOKEN --ask 2>/dev/null)',
    'echo "set=$? placeholder=$P"',
    'echo "after=$(sealed ask FRESH_TOKEN --reveal)"',
  ].join('; ');
  const seen = await ran(t, 'fnox set --ask mid-command', {
    command,
    fnox: true,
    config: 'default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n',
    typed: { FRESH_TOKEN: FRESH },
    plan: { 'ask FRESH_TOKEN': ['seal'] },
  });
  clean(seen, [FRESH]);
  assert.equal(seen.answer, 'Done.');
  const fresh = seen.placeholders.FRESH_TOKEN;
  assert.deepEqual(seen.results, [`start\nset=0 placeholder=${fresh}\nafter=${fresh}\n`]);
  assert.ok(seen.errors.includes('push EAGAIN'), seen.errors.join());
});

test('scrub reopen: a value another process seals while a command runs is scrubbed, and output already shown is not repeated', async (t) => {
  const command = ['echo one', MARK, `printf 'two=%s\\n' ${split(OTHER.value)}`, 'echo three'].join(
    '; '
  );
  const seen = await ran(t, 'a value sealed elsewhere', {
    command,
    plan: { 'placeholder MARK': ['other'] },
  });
  clean(seen, [OTHER.value]);
  assert.equal(seen.answer, 'Done.');
  assert.deepEqual(seen.results, [`one\ntwo=${OTHER.placeholder}\nthree\n`]);
  assert.ok(seen.errors.includes('push EAGAIN'), seen.errors.join());
});

test('scrub reopen: repeated changes, also while the stream is reopened, keep every sealed value scrubbed', async (t) => {
  const command = [
    'echo start',
    'A=$(sealed ask FRESH_TOKEN --reveal)',
    'echo "a=$A"',
    'B=$(sealed ask SECOND_TOKEN --reveal)',
    'echo "b=$B"',
    `printf 'a-again=%s\\n' ${split(FRESH)}`,
  ].join('; ');
  const seen = await ran(t, 'repeated changes', {
    command,
    typed: { FRESH_TOKEN: FRESH, SECOND_TOKEN: SECOND },
    plan: { 'ask FRESH_TOKEN': ['seal'], 'ask SECOND_TOKEN': ['seal', 'again', 'again'] },
  });
  clean(seen, [FRESH, SECOND]);
  assert.equal(seen.answer, 'Done.');
  const { FRESH_TOKEN: fresh, SECOND_TOKEN: second } = seen.placeholders;
  assert.deepEqual(seen.results, [`start\na=${fresh}\nb=${second}\na-again=${fresh}\n`]);
  assert.equal(
    seen.errors.filter((error) => error === 'push EAGAIN').length,
    3,
    seen.errors.join()
  );
});

test('scrub reopen: a stream the vault will not reopen withholds the output and fails the call', async (t) => {
  const command = [
    MARK,
    `printf 'before=%s\\n' ${split(FRESH)}`,
    'V=$(sealed ask FRESH_TOKEN --reveal)',
    'echo "after=$V"',
  ].join('; ');
  const seen = await ran(t, 'a stream that cannot be reopened', {
    command,
    typed: { FRESH_TOKEN: FRESH },
    plan: { 'placeholder MARK': ['hold'], 'ask FRESH_TOKEN': ['seal', 'refuse', 'release'] },
  });
  clean(seen, [FRESH]);
  assert.ok(seen.errors.includes('redactStream EACCES'), seen.errors.join());
  assert.deepEqual(seen.results, ['<harness>\n[error] unlock the vault to continue\n</harness>']);
});

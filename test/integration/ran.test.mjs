import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (args) => ({ tool: { name: 'bash', args } });
const answer = (text) => ({ answer: text });

const PACKAGES = {
  'node_modules/@ai-ecoverse/wasm-sed/': ['package.json', 'bin/sed', 'bin/sed.wasm'],
  'node_modules/@ai-ecoverse/slicc-jsh/': [
    'package.json',
    'dist/node.mjs',
    'dist/jsh.mjs',
    'dist/vendor/readable-stream.cjs',
    'dist/vendor/string_decoder.cjs',
    'dist/vendor/node-lib.cjs',
  ],
};

const SAYERS = [
  'mkdir -p /tmp/bin',
  "printf '#!/bin/sh\\nexit 0\\n' > /tmp/bin/intent",
  'chmod +x /tmp/bin/intent',
  'cp /tmp/bin/intent /tmp/bin/playwright-cli',
].join(' && ');

const MANY = [
  'basename',
  'dirname',
  'date',
  'env',
  'expr',
  'id',
  'nproc',
  'sort',
  'tr',
  'uname',
  'wc',
  'whoami',
  'head',
  'tail',
  'cut',
  'od',
  'seq',
  'cat',
  'ls',
  'sleep',
  'true',
  'false',
];

const helpers = () => {
  window.boot = async ({ query, packages }) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel(packages);
    const owner = await startTracked({
      worker: () =>
        (window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' })),
      kernel: { connect: () => kernel.connect() },
    });
    window.owner = owner;
    window.local = await owner.connect();
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    window.model = createAgentModel(window.local, { guests: hub });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.until = (check, what) => when([changed, every(100)], check, what);
  window.cards = (agent = window.agent) =>
    agent
      .messages('cone')
      .filter((message) => message.role === 'assistant' && message.id !== 'live')
      .flatMap((message) => message.parts.filter((part) => part.type === 'tool'))
      .map(({ tool }) => ({
        id: tool.id,
        title: tool.title,
        meta: tool.meta ?? null,
        notes: tool.notes ?? [],
        status: tool.status,
        output: tool.output,
      }));
  window.said = () =>
    (window.local.views.value?.cone?.entries ?? []).flatMap((entry) =>
      entry.kind === 'pi.assistant'
        ? (entry.model?.[0]?.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
        : []
    );
  window.details = () =>
    (window.local.views.value?.cone?.entries ?? [])
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model?.[0]?.details ?? null);
  window.labelInputs = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => resolve(data);
      window.worker.postMessage({ labelInputs: channel.port2 }, [channel.port2]);
    });
  window.run = async (text, done) => {
    const started = Date.now();
    await window.agent.send(window.agent.active(), text);
    await window.until(() => window.said().includes(done), done);
    return Date.now() - started;
  };
};

function queryOf(steps, extra = []) {
  const params = new URLSearchParams(extra);
  for (const step of steps) params.append('step', JSON.stringify(step));
  return params.toString();
}

async function boot(page, steps, extra = []) {
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the traced agent', (options) => window.boot(options), {
    query: queryOf(steps, extra),
    packages: PACKAGES,
  });
}

const namesOf = (title) => {
  const listed = /^Running (.+)$/.exec(title)?.[1] ?? '';
  return listed
    .split(/, | and /)
    .filter(Boolean)
    .sort();
};

const META = /^Ran (.+) · \d+\.\d s$/;

const metaNames = (meta) =>
  (META.exec(meta ?? '')?.[1] ?? '')
    .split(/, | and /)
    .filter(Boolean)
    .sort();

test('a bash call is titled by the programs its trace saw, with their failures as notes, also after a reload', async (t) => {
  const page = await chrome.page(t);
  const screenshot =
    'cd /tmp; for i in 1 2; do printf \'%s\\n\' "$i"; done 2>&1; seq 1 2 > /dev/null';
  const many = MANY.map((name) => `/usr/bin/${name} --version > /dev/null 2>&1`).join('; ');
  const steps = [
    bash({ command: screenshot }),
    bash({ command: 'seq 1 3 | sed -n 2p | head -1' }),
    bash({ command: 'timeout 5 true' }),
    bash({ command: 'echo a; node -e "console.log(1)"' }),
    bash({ command: 'ls /nope; echo done' }),
    bash({ command: 'seq 1 10000000 | head -1' }),
    bash({ command: 'echo a; node -e "process.exit(3)"' }),
    bash({
      command: `${SAYERS} && /tmp/bin/playwright-cli open --intent "Checking the result list" && /tmp/bin/intent click --intent=Clicking`,
    }),
    bash({
      intent: 'Taking the screenshot',
      command: '/tmp/bin/intent shot --intent "Other words"',
    }),
    bash({ command: many }),
    bash({ command: 'cd /tmp; for i in 1 2; do echo "$i"; done' }),
    bash({ command: 'sleep 5 & job=$!; sleep 0.5; kill -9 $job; wait $job; echo after' }),
    bash({ command: 'sleep 5; echo never', timeout: 1 }),
    answer('Done.'),
  ];
  await boot(page, steps);
  const seen = await staged(page, 'a traced run', async () => {
    await window.run('Go.', 'Done.');
    const cards = window.cards();
    const labels = [
      await window.agent.stepLabel('cone', cards[4].id),
      await window.agent.stepLabel('cone', cards[7].id),
    ];
    const again = createAgentModel(await window.owner.connect()).agent;
    await again.ready();
    await window.until(() => window.cards(again).length === cards.length, 'the reload');
    return {
      cards,
      details: window.details(),
      labels,
      inputs: await window.labelInputs(),
      reloaded: window.cards(again),
    };
  });
  const { cards, details } = seen;
  const [
    shot,
    piped,
    timed,
    replaced,
    failing,
    sigpipe,
    exited,
    argv,
    own,
    bounded,
    builtins,
    killed,
    late,
  ] = cards;
  assert.equal(shot.title, 'Running seq');
  assert.match(shot.meta, /^Ran seq · \d+\.\d s$/);
  for (const word of ['cd', 'for', 'printf', '2>&1'])
    assert.ok(!shot.title.includes(word) && !shot.meta.includes(word), shot.title);
  assert.deepEqual(namesOf(piped.title), ['head', 'sed', 'seq']);
  assert.deepEqual(metaNames(piped.meta), ['head', 'sed', 'seq']);
  assert.equal(piped.output.trim(), '2');
  assert.deepEqual(namesOf(timed.title), ['timeout', 'true']);
  assert.equal(replaced.title, 'Running node');
  assert.equal(replaced.output.trim(), 'a\n1');
  assert.equal(failing.title, 'Running ls');
  assert.equal(failing.status, 'done');
  assert.deepEqual(failing.notes, [{ severity: 'error', text: 'ls exited 2' }]);
  assert.deepEqual(namesOf(sigpipe.title), ['head', 'seq']);
  assert.deepEqual(sigpipe.notes, []);
  const seq = details[5].ran.programs.find((program) => program.name === 'seq');
  assert.ok(seq.status === 0 || seq.quiet === true, JSON.stringify(seq));
  assert.equal(exited.title, 'Running node');
  assert.equal(exited.status, 'error');
  assert.deepEqual(exited.notes, [{ severity: 'error', text: 'Exited with code 3' }]);
  assert.equal(argv.title, 'Checking the result list');
  assert.equal(details[7].ran.intent, 'Checking the result list');
  assert.deepEqual(metaNames(argv.meta), ['chmod', 'cp', 'intent', 'mkdir', 'playwright-cli']);
  assert.equal(own.title, 'Taking the screenshot');
  assert.equal(bounded.title.endsWith(' and more'), true, bounded.title);
  assert.equal(details[9].ran.programs.length, 16);
  assert.equal(details[9].ran.more, MANY.length - 16);
  assert.match(bounded.meta, /^Ran (\S+, ){7}\S+ and more · \d+\.\d s$/);
  assert.equal(builtins.title, 'Running cd, for, do and more');
  assert.match(builtins.meta, /^Ran only shell builtins · \d+\.\d s$/);
  assert.deepEqual(details[10].ran.programs, []);
  assert.equal(killed.title, 'Running sleep');
  assert.deepEqual(killed.notes, [{ severity: 'error', text: 'sleep was killed (SIGKILL)' }]);
  assert.equal(late.status, 'error');
  assert.equal(late.title, 'Running sleep');
  assert.deepEqual(
    late.notes.map((item) => item.text),
    ['Timed out after 1 seconds']
  );
  for (const detail of details) {
    assert.equal(typeof detail.ran.ms, 'number');
    assert.equal(detail.ran.dropped, undefined);
    assert.equal(JSON.stringify(detail).includes('10000000'), false);
  }
  assert.equal(seen.labels[1], null);
  assert.ok(
    seen.inputs.includes('bash: {"command":"ls /nope; echo done"}\nran: ls; ls exited 2'),
    JSON.stringify(seen.inputs)
  );
  assert.deepEqual(seen.reloaded, cards);
});

test('a background job that outlives its command is traced for 2 s after bash exits, the call does not wait for it to end, and a freeze and thaw show the same', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    bash({ command: 'sleep 20 > /dev/null 2>&1 & echo started' }),
    bash({ command: '(sleep 1; seq 1 2 > /dev/null) > /dev/null 2>&1 & echo started' }),
    answer('Done.'),
  ]);
  const seen = await staged(page, 'a background job', async () => {
    const took = await window.run('Go.', 'Done.');
    const cards = window.cards();
    const frozen = await window.local.control.freeze('cone', BACKGROUND_CONTEXT);
    await window.until(
      () =>
        window.agent.frozen().some((row) => row.id === frozen.id) && window.cards().length === 0,
      'the frozen cone'
    );
    const thawed = window.agent.thaw(frozen.id);
    window.agent.select(thawed.id);
    await window.until(() => window.cards().length === cards.length, 'the thawed cone');
    return { took, cards, details: window.details(), thawed: window.cards() };
  });
  assert.deepEqual(seen.thawed, seen.cards);
  assert.ok(seen.took < 15000, String(seen.took));
  const [long, short] = seen.cards;
  assert.equal(long.title, 'Running sleep');
  assert.deepEqual(seen.details[0].ran.programs, [{ name: 'sleep' }]);
  assert.deepEqual(long.notes, []);
  assert.deepEqual(namesOf(short.title), ['seq', 'sleep']);
  assert.deepEqual(
    seen.details[1].ran.programs.map((program) => program.status),
    [0, 0]
  );
});

for (const missing of ['trace', 'tags'])
  test(`on a kernel without ${missing === 'trace' ? 'trace' : 'tag lists'} (ENOSYS) a bash call runs as before, with its parsed title and no trace`, async (t) => {
    const page = await chrome.page(t);
    await boot(
      page,
      [bash({ command: 'cd /tmp; seq 1 2 2>&1' }), answer('Done.')],
      [['older-kernel', missing]]
    );
    const seen = await staged(page, 'an older kernel', async () => {
      await window.run('Go.', 'Done.');
      return { cards: window.cards(), details: window.details() };
    });
    assert.equal(seen.cards[0].title, 'Running cd, seq and 1');
    assert.equal(seen.cards[0].meta, null);
    assert.equal(seen.cards[0].output.trim(), '1\n2');
    assert.equal(seen.details[0], null);
  });

test("a guest run's argv --intent never titles its call: it shows the programs, and its details keep no intent", async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    bash({ command: SAYERS }),
    answer('Owner done.'),
    bash({ command: '/tmp/bin/intent read --intent "Reading the harmless docs"' }),
    answer('Guest done.'),
  ]);
  const seen = await staged(page, "a guest run's argv intent", async () => {
    await window.run('Mine.', 'Owner done.');
    const minted = await window.model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    const guest = await window.owner
      .port({ guest: { id: minted.seat.id, label: 'Anna' } })
      .then(connectGuest)
      .then(track);
    await guest.control.send(
      { text: 'Read the docs.', whenBusy: 'followUp', requestId: null },
      BACKGROUND_CONTEXT
    );
    const asked = () =>
      window.model.approvals.list().filter((approval) => approval.kind === 'guest-tool');
    const [first] = await window.until(() => asked().length && asked(), 'the guest call');
    await window.model.approvals.decide(first.id, 'once', null);
    await window.until(() => window.said().includes('Guest done.'), 'the guest bash');
    const shown = JSON.stringify(guest.transcript.value).includes('"ran"');
    const leaked = JSON.stringify(guest.transcript.value).includes('"intent":"Reading');
    await guest.close();
    return { cards: window.cards(), details: window.details(), shown, leaked };
  });
  assert.equal(seen.cards[1].title, 'Running intent');
  assert.equal(seen.details[1].ran.intent, undefined);
  assert.equal(seen.shown, true);
  assert.equal(seen.leaked, false);
});

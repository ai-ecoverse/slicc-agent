import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, staged } from './chrome.mjs';
import mainPrompt from './fixtures/lease-prompt-main.json' with { type: 'json' };

const chrome = await launch();
after(() => chrome.close());

const SENT =
  "Proposal 1 sent to the owner. Nothing has started, and you won't receive its status or any page content.";
const OPEN = 'A proposal is already waiting for the owner.';
const RESTARTED = "The agent restarted; nothing was sent. Propose again if it's still needed.";
const HOURLY = 'This cone already sent six proposals in the last hour.';
const QUERY = "That URL can't include a query.";
const SCOOP = "Proposals only work in a cone's current conversation.";
const SEAT = 'A guest seat is open on this cone.';
const GATED = "This run can't propose a browser lease.";
const UNAVAILABLE = "Proposals aren't available here.";
const PROMPT =
  'lease_propose asks the owner to let a browser job read one page; it only proposes, returns no page content and reports no status.';
const KEYS = {
  hello: ['epoch', 'type', 'v'],
  proposal: ['agentId', 'at', 'epoch', 'expiresAt', 'proposal', 'reason', 'type', 'url', 'v'],
  withdrawn: ['epoch', 'proposal', 'reason', 'type', 'v'],
};

const helpers = () => {
  globalThis.SENT =
    "Proposal 1 sent to the owner. Nothing has started, and you won't receive its status or any page content.";
  globalThis.OPEN = 'A proposal is already waiting for the owner.';
  globalThis.RESTARTED =
    "The agent restarted; nothing was sent. Propose again if it's still needed.";
  globalThis.HOURLY = 'This cone already sent six proposals in the last hour.';
  globalThis.SCOOP = "Proposals only work in a cone's current conversation.";
  globalThis.SEAT = 'A guest seat is open on this cone.';
  globalThis.GATED = "This run can't propose a browser lease.";
  globalThis.UNAVAILABLE = "Proposals aren't available here.";
  globalThis.propose = (url, reason) => ({
    tool: { name: 'lease_propose', args: { url, reason } },
  });
  globalThis.gatedPropose = (url, reason, gate) => ({
    gate,
    tool: { name: 'lease_propose', args: { url, reason } },
  });
  globalThis.answer = (text) => ({ answer: text });
  globalThis.bash = (command) => ({ tool: { name: 'bash', args: { command } } });
  window.bootLease = async ({
    steps: list = [],
    later = [],
    lease = true,
    leaseV = 1,
    persist = null,
    holdLease = null,
    clock = false,
    extra = [],
    scoopSteps = [],
  } = {}) => {
    const { bootKernel } = await import('/kernel.js');
    const page = await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let lives = 0;
    let worker;
    const bios = { messages: [], epoch: null, raw: [] };
    const workerFile = clock ? 'clock-main-worker.js' : 'main-worker.js';
    const url = (which) =>
      `/dist-test/${workerFile}?${new URLSearchParams([
        ...(persist ? [['persist', persist]] : []),
        ...(holdLease ? [['hold-lease', holdLease]] : []),
        ...extra,
        ...which.map((step) => ['step', JSON.stringify(step)]),
        ...scoopSteps.map((step) => ['scoop-step', JSON.stringify(step)]),
      ])}`;
    const owner = await startTracked({
      worker: () => {
        lives += 1;
        worker = new Worker(url(lives === 1 ? list : later), { type: 'module' });
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
      ...(lease
        ? {
            lease: {
              v: leaseV,
              connect: () => {
                const { port1, port2 } = new MessageChannel();
                bios.epoch = null;
                port1.start();
                port1.onmessage = ({ data }) => {
                  bios.raw.push(data);
                  const message = page.acceptWorkerMessage(data, bios.epoch ?? undefined);
                  if (!message) return;
                  if (message.type === 'hello') bios.epoch = message.epoch;
                  bios.messages.push(message);
                };
                bios.port = port1;
                return port2;
              },
            },
          }
        : {}),
    });
    const until = (check, what) => when([changed, every(100)], check, what);
    const ask = (key, extraMsg = {}) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data);
        worker.postMessage({ ...extraMsg, [key]: channel.port2 }, [channel.port2]);
      });
    let connection = await owner.connect();
    const results = (agentId = 'cone') =>
      (connection.views.value?.[agentId]?.entries ?? [])
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) =>
          (entry.model?.[0]?.content ?? [])
            .map((block) => block.text ?? '')
            .join('')
            .trim()
        );
    const said = (agentId = 'cone') =>
      (connection.views.value?.[agentId]?.entries ?? []).flatMap((entry) =>
        entry.kind === 'pi.assistant'
          ? (entry.model?.[0]?.content ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
          : []
      );
    const prompt = (text, agentId = 'cone') =>
      connection.control.send(
        { text, whenBusy: 'followUp', requestId: null, agentId },
        BACKGROUND_CONTEXT
      );
    return {
      owner,
      worker: () => worker,
      get connection() {
        return connection;
      },
      async reconnect() {
        connection = await owner.connect();
        return connection;
      },
      bios,
      until,
      ask,
      results,
      said,
      prompt,
      lives: () => lives,
      cancel: (message) => bios.port?.postMessage(message),
      releaseLease: () => worker.postMessage({ releaseLease: true }),
    };
  };
};

test('without the capability the tool is absent and the prompt matches today', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'without the capability', async () => {
    const off = await window.bootLease({
      lease: false,
      steps: [answer('Hi.')],
    });
    await off.prompt('Hello?');
    await off.until(() => off.said().includes('Hi.'), 'answer');
    const offReq = await off.ask('requests');
    await off.owner.release();
    const on = await window.bootLease({
      lease: true,
      steps: [answer('Hi.')],
    });
    await on.prompt('Hello?');
    await on.until(() => on.said().includes('Hi.'), 'answer with lease');
    const onReq = await on.ask('requests');
    await on.owner.release();
    const wrong = await window.bootLease({
      lease: true,
      leaseV: 2,
      steps: [answer('Hi.')],
    });
    await wrong.prompt('Hello?');
    await wrong.until(() => wrong.said().includes('Hi.'), 'answer wrong v');
    const wrongReq = await wrong.ask('requests');
    await wrong.owner.release();
    return { offReq, onReq, wrongReq, bios: on.bios.messages };
  });
  const systemOf = (raw) => {
    const context = JSON.parse(raw);
    return context.messages?.[0] ?? context;
  };
  const offMessage = systemOf(seen.offReq[0]);
  const onMessage = systemOf(seen.onReq[0]);
  const wrongMessage = systemOf(seen.wrongReq[0]);
  const toolsOf = (message) => message.toolsAdded ?? message.tools ?? [];
  const sectionsOf = (message) => Object.values(message.sections ?? {}).join('\n');
  const offTools = JSON.stringify(toolsOf(offMessage));
  const offSections = sectionsOf(offMessage);
  const wrongTools = JSON.stringify(toolsOf(wrongMessage));
  const wrongSections = sectionsOf(wrongMessage);
  assert.ok(!offTools.includes('lease_propose'));
  assert.ok(!offSections.includes(PROMPT));
  assert.ok(JSON.stringify(toolsOf(onMessage)).includes('lease_propose'));
  assert.ok(sectionsOf(onMessage).includes(PROMPT));
  assert.ok(!wrongTools.includes('lease_propose'));
  assert.ok(!wrongSections.includes(PROMPT));
  assert.deepEqual(
    { tools: offTools, sections: offSections },
    { tools: wrongTools, sections: wrongSections }
  );
  assert.equal(offTools, mainPrompt.tools);
  assert.equal(offSections, mainPrompt.sections);
  assert.equal(seen.bios[0]?.type, 'hello');
  const offTokens = Math.ceil((offSections.length + offTools.length) / 4);
  const onTools = JSON.stringify(toolsOf(onMessage));
  const onSections = sectionsOf(onMessage);
  const onTokens = Math.ceil((onSections.length + onTools.length) / 4);
  assert.equal(offTokens, mainPrompt.tokens);
  console.log(
    `prompt tokens main baseline: ${mainPrompt.tokens}; without lease: ${offTokens}; with lease: ${onTokens}`
  );
});

test('shipped agent-worker entry ignores hold-lease and releaseLease', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const shipped = readFileSync(`${root}/src/agent-worker.ts`, 'utf8');
  const testWorker = readFileSync(`${root}/test/integration/page/main-worker.js`, 'utf8');
  assert.match(shipped, /runAgentWorker\(globalThis as unknown as AgentWorkerScope\);/);
  assert.doesNotMatch(shipped, /holdLease|hold-lease|releaseLease/);
  assert.match(testWorker, /hold-lease/);
  assert.match(testWorker, /holdLease: params\.get\('hold-lease'\)/);
});

test('lease_propose sends a proposal and refuses a second open one', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'lease_propose sends a proposal', async () => {
    const r = await window.bootLease({
      steps: [
        propose('https://example.com/page', 'Need the docs'),
        answer('Sent.'),
        propose('https://example.com/other', 'Again'),
        answer('Refused.'),
      ],
    });
    await r.prompt('Propose.');
    await r.until(() => r.results().length >= 1, 'first result');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal on port');
    await r.until(() => r.said().includes('Sent.'), 'first answer');
    await r.prompt('Again.');
    await r.until(() => r.results().length >= 2, 'second result');
    await r.until(() => r.said().includes('Refused.'), 'second answer');
    const out = {
      results: r.results(),
      bios: r.bios.messages.map((m) => ({ type: m.type, proposal: m.proposal, url: m.url })),
      keys: r.bios.messages.map((m) => ({ type: m.type, keys: Object.keys(m).sort() })),
      epoch: r.bios.epoch,
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.results[0], SENT);
  assert.equal(seen.results[1], OPEN);
  assert.ok(!seen.results[0].includes('https://'));
  assert.ok(!seen.results[0].includes(seen.epoch));
  assert.equal(seen.bios.filter((m) => m.type === 'proposal').length, 1);
  assert.equal(seen.bios.find((m) => m.type === 'proposal')?.url, 'https://example.com/page');
  for (const message of seen.keys) {
    assert.deepEqual(message.keys, KEYS[message.type]);
  }
});

test('url and reason refusals', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const cases = [
    ['https://example.com/x?q=1', 'why', QUERY],
    ['https://example.com/x?', 'why', QUERY],
    ['https://example.com/x#f', 'why', "That URL can't include a fragment."],
    ['https://example.com/#', 'why', "That URL can't include a fragment."],
    ['http://example.com/x', 'why', 'Only https URLs can be proposed.'],
    ['https://user:pass@example.com/x', 'why', "That URL can't include a username or password."],
    [`https://example.com/${'a'.repeat(2100)}`, 'why', 'That URL is too long.'],
    ['https://example.com/\u0001', 'why', "That URL contains characters that aren't allowed."],
    ['https://example.com/\u200b', 'why', "That URL contains characters that aren't allowed."],
    ['https://example.com/\u202e', 'why', "That URL contains characters that aren't allowed."],
    ['https://example.com/ok', 'x'.repeat(300), 'That reason is too long.'],
    ['https://example.com/ok', 'bad\u200b', "That reason contains characters that aren't allowed."],
    ['https://example.com/ok', 'bad\u0001', "That reason contains characters that aren't allowed."],
  ];
  const seen = await staged(
    page,
    'url and reason refusals',
    async (list) => {
      const r = await window.bootLease({
        steps: list.flatMap(([url, reason]) => [propose(url, reason), answer('Noted.')]),
      });
      for (let i = 0; i < list.length; i++) {
        await r.prompt(`Case ${i}`);
        await r.until(() => r.results().length >= i + 1, `result ${i}`);
      }
      const out = {
        results: r.results(),
        bios: r.bios.messages.filter((m) => m.type === 'proposal'),
      };
      await r.owner.release();
      return out;
    },
    cases
  );
  assert.deepEqual(
    seen.results,
    cases.map((row) => row[2])
  );
  assert.equal(seen.bios.length, 0);
});

test('cancel withdraws, is idempotent, and ignores other epochs', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'cancel withdraws', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    const proposal = r.bios.messages.find((m) => m.type === 'proposal');
    const beforeBad = r.bios.messages.filter((m) => m.type === 'withdrawn').length;
    r.cancel({ v: 1, type: 'cancel', epoch: 'a'.repeat(32), proposal: proposal.proposal });
    r.cancel({
      v: 1,
      type: 'cancel',
      epoch: r.bios.epoch,
      proposal: proposal.proposal,
      extra: true,
    });
    r.cancel({ v: 2, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterBad = r.bios.messages.filter((m) => m.type === 'withdrawn').length;
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'cancelled'),
      'withdrawn'
    );
    const before = r.bios.messages.length;
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const out = {
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn'),
      after: r.bios.messages.length - before,
      bad: afterBad - beforeBad,
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.bad, 0);
  assert.equal(seen.withdrawn.length, 1);
  assert.equal(seen.withdrawn[0].reason, 'cancelled');
  assert.equal(seen.after, 0);
});

test('expiry sends withdrawn expired', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'expiry sends withdrawn', async () => {
    const base = Date.now();
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
      clock: true,
      extra: [['now', String(base)]],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    const clock = new BroadcastChannel('slicc-test-clock');
    clock.postMessage({ now: base + 6 * 60 * 1000 });
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'expired'),
      'expired'
    );
    const out = r.bios.messages.filter((m) => m.type === 'withdrawn');
    await r.owner.release();
    return out;
  });
  assert.equal(seen[0].reason, 'expired');
});

test('an open guest seat refuses and withdraws a waiting proposal as stale', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'open guest seat', async () => {
    const r = await window.bootLease({
      steps: [
        propose('https://example.com/a', 'Need it'),
        answer('Sent.'),
        propose('https://example.com/b', 'Again'),
        answer('Seat.'),
      ],
    });
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    const model = createAgentModel(r.connection, { guests: hub });
    await model.agent.ready();
    await r.prompt('Propose.');
    await r.until(() => r.results()[0] === SENT, 'sent');
    const minted = await model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    await r.until(() => model.guests.list().some((seat) => seat.id === minted.seat.id), 'listed');
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'stale'),
      'stale'
    );
    await r.prompt('Again.');
    await r.until(() => r.results().length >= 2, 'seat refusal');
    const out = {
      results: r.results(),
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn'),
      seat: minted.seat?.id ?? null,
    };
    await r.owner.release();
    return out;
  });
  assert.ok(seen.seat);
  assert.equal(seen.results[1], SEAT);
  assert.equal(seen.withdrawn[0].reason, 'stale');
});

test('the hourly cap refuses a seventh proposal in the rolling hour', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'hourly cap', async () => {
    const list = [];
    for (let i = 0; i < 6; i++)
      list.push(propose(`https://example.com/p${i}`, `r${i}`), answer(`A${i}.`));
    list.push(propose('https://example.com/overflow', 'nope'), answer('Cap.'));
    const r = await window.bootLease({ steps: list });
    for (let i = 0; i < 6; i++) {
      await r.prompt(`P${i}`);
      await r.until(() => r.results().length >= i + 1, `sent ${i}`);
      r.cancel({
        v: 1,
        type: 'cancel',
        epoch: r.bios.epoch,
        proposal: r.bios.messages.filter((m) => m.type === 'proposal').at(-1).proposal,
      });
      await r.until(
        () =>
          r.bios.messages.filter((m) => m.type === 'withdrawn' && m.reason === 'cancelled')
            .length >=
          i + 1,
        `cancel ${i}`
      );
    }
    await r.prompt('Overflow');
    await r.until(() => r.results().at(-1) === HOURLY, 'hourly');
    const out = {
      last: r.results().at(-1),
      proposals: r.bios.messages.filter((m) => m.type === 'proposal').length,
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.last, HOURLY);
  assert.equal(seen.proposals, 6);
});

test('restart sends a new hello and a held resume does not publish again', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'restart held resume', async () => {
    const r = await window.bootLease({
      persist: `/.slicc/lease-hold-${Date.now()}`,
      holdLease: 'published',
      steps: [propose('https://example.com/held', 'hold me'), answer('Done.')],
      later: [answer('After.')],
    });
    void r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'published');
    const firstEpoch = r.bios.epoch;
    const before = r.bios.messages.filter((m) => m.type === 'proposal').length;
    await r.connection.close?.();
    await r.owner.restart();
    await r.reconnect();
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'hello' && m.epoch !== firstEpoch),
      'new hello'
    );
    await r.until(() => r.results().includes(RESTARTED), 'resume result');
    const out = {
      firstEpoch,
      secondEpoch: r.bios.epoch,
      proposals: r.bios.messages.filter((m) => m.type === 'proposal').length,
      before,
      results: r.results(),
      hellos: r.bios.messages.filter((m) => m.type === 'hello').map((m) => m.epoch),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.hellos.length, 2);
  assert.notEqual(seen.firstEpoch, seen.secondEpoch);
  assert.equal(seen.proposals, 1);
  assert.equal(seen.proposals, seen.before);
  assert.ok(seen.results.includes(RESTARTED));
  assert.equal(seen.results.filter((text) => text === RESTARTED).length, 1);
});

test('duplicate and unknown port fields are dropped both ways', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'duplicate fields dropped', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    const proposal = r.bios.messages.find((m) => m.type === 'proposal').proposal;
    const before = r.bios.messages.length;
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal, extra: 1 });
    r.cancel({ v: 1, type: 'nope', epoch: r.bios.epoch, proposal });
    r.cancel('not-json-object');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const out = { grew: r.bios.messages.length - before };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.grew, 0);
});

test('a scoop conversation refuses lease_propose', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'scoop refuses', async () => {
    const r = await window.bootLease({
      steps: [answer('Cone ready.')],
      scoopSteps: [propose('https://example.com/scoop', 'from scoop'), answer('Scoop.')],
    });
    await r.prompt('Ready.');
    await r.until(() => r.said().includes('Cone ready.'), 'cone ready');
    const scoop = await r.connection.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    await r.prompt('Propose from scoop.', scoop.id);
    await r.until(() => r.results(scoop.id).length >= 1, 'scoop result');
    const out = {
      results: r.results(scoop.id),
      bios: r.bios.messages.filter((m) => m.type === 'proposal'),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.results[0], SCOOP);
  assert.equal(seen.bios.length, 0);
});

test('freeze withdraws a waiting proposal as stale', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'freeze withdraws stale', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.results()[0] === SENT, 'sent');
    const frozen = await r.connection.control.freeze('cone', BACKGROUND_CONTEXT);
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'stale'),
      'stale'
    );
    const out = {
      frozen,
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn'),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.frozen.error, null);
  assert.equal(seen.withdrawn[0].reason, 'stale');
});

test('rewind withdraws a waiting proposal as stale', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'rewind stale', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.results()[0] === SENT, 'sent');
    await r.until(() => r.said().includes('Sent.'), 'answered');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    const entries = r.connection.views.value?.cone?.entries ?? [];
    const answers = entries.filter((entry) => entry.kind === 'pi.assistant');
    const target = answers[0] ?? answers.at(-1);
    const messageId = `e${target.id}`;
    const rewound = await r.connection.control.rewindAgent('cone', messageId, BACKGROUND_CONTEXT);
    await r.until(
      () =>
        (r.connection.views.value?.cone?.entries ?? []).some(
          (entry) => entry.kind === 'slicc.rewound'
        ),
      'fork'
    );
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'stale'),
      'rewind stale'
    );
    const out = {
      rewound: rewound.done,
      reason: rewound.reason ?? null,
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn'),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.rewound, true);
  assert.equal(seen.withdrawn[0].reason, 'stale');
});

test('new chat withdraws a waiting proposal as stale', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'new chat stale', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    await r.connection.control.newChat('cone', BACKGROUND_CONTEXT);
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'stale'),
      'new chat stale'
    );
    const out = r.bios.messages.filter((m) => m.type === 'withdrawn');
    await r.owner.release();
    return out;
  });
  assert.equal(seen[0].reason, 'stale');
});

test('a gated guest run refuses lease_propose and publishes nothing', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'gated guest run', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/gated', 'from guest'), answer('Gated.')],
    });
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    const model = createAgentModel(r.connection, { guests: hub });
    await model.agent.ready();
    const minted = await model.guests.mint('cone', {
      label: 'Anna',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    const guest = track(
      await connectGuest(await r.owner.port({ guest: { id: minted.seat.id, label: 'Anna' } }))
    );
    void guest.control.send(
      { text: 'Propose.', whenBusy: 'followUp', requestId: null },
      BACKGROUND_CONTEXT
    );
    await r.until(
      () => model.approvals.list().some((item) => item.kind === 'guest-tool'),
      'approval'
    );
    const pending = model.approvals.list().find((item) => item.kind === 'guest-tool');
    await model.approvals.decide(pending.id, 'once');
    await r.until(() => r.results().includes(GATED), 'gated outcome');
    const out = {
      results: r.results(),
      bios: r.bios.messages.filter((m) => m.type === 'proposal'),
    };
    await guest.close();
    await r.owner.release();
    return out;
  });
  assert.equal(seen.bios.length, 0);
  assert.equal(seen.results.at(-1), GATED);
});

test('an open proposal withdraws as stale when the conversation is tainted', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'taint stale', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/a', 'Need it'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    const model = createAgentModel(r.connection, { guests: hub });
    await model.agent.ready();
    await model.guests.mint('cone', {
      label: 'Cara',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'stale'),
      'stale'
    );
    const out = r.bios.messages.filter((m) => m.type === 'withdrawn');
    await r.owner.release();
    return out;
  });
  assert.equal(seen[0].reason, 'stale');
});

test('new chat then a fresh proposal survives an AgentsDoc change', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'new chat then propose', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/fresh', 'keep me'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.bios.messages.some((m) => m.type === 'proposal'), 'proposal');
    await r.until(() => r.results()[0] === SENT, 'sent');
    const before = r.bios.messages.filter((m) => m.type === 'withdrawn').length;
    await r.connection.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const out = {
      proposals: r.bios.messages.filter((m) => m.type === 'proposal').length,
      withdrawnAfter: r.bios.messages.filter((m) => m.type === 'withdrawn').length - before,
      results: r.results(),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.proposals, 1);
  assert.equal(seen.withdrawnAfter, 0);
  assert.equal(seen.results[0], SENT);
});

test('a seat opening during reserve refuses without publishing or withdrawing', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'seat races reserve', async () => {
    const r = await window.bootLease({
      holdLease: 'reserve',
      steps: [propose('https://example.com/race', 'race seat'), answer('Refused.')],
    });
    void r.prompt('Propose.');
    await r.until(() => {
      const entries = r.connection.views.value?.cone?.entries ?? [];
      return entries.some((entry) => JSON.stringify(entry).includes('lease_propose'));
    }, 'tool started');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const hub = {
      minted: 0,
      async mint() {
        this.minted += 1;
        return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
      },
      async revoke() {},
    };
    const model = createAgentModel(r.connection, { guests: hub });
    await model.agent.ready();
    await model.guests.mint('cone', {
      label: 'Race',
      expiresAt: null,
      gates: { messages: 'off', tools: 'user' },
    });
    r.releaseLease();
    await r.until(() => r.results().includes(UNAVAILABLE) || r.results().includes(SEAT), 'refused');
    const out = {
      results: r.results(),
      proposals: r.bios.messages.filter((m) => m.type === 'proposal').length,
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn').length,
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.proposals, 0);
  assert.equal(seen.withdrawn, 0);
  assert.ok(seen.results[0] === UNAVAILABLE || seen.results[0] === SEAT);
});

test('proposal values stay out of inventory beyond the ordinary tool call', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'inventory stays clean', async () => {
    const r = await window.bootLease({
      steps: [propose('https://example.com/secret-path', 'secret-reason-xyz'), answer('Sent.')],
    });
    await r.prompt('Propose.');
    await r.until(() => r.results()[0] === SENT, 'sent');
    const remote = remoteControl(r.connection);
    const inventory = await remote.inventory();
    const snapshot = inventory?.state?.value ?? inventory ?? r.connection.inventory?.value ?? {};
    const views = r.connection.views.value ?? {};
    const viewsText = JSON.stringify(views);
    const inventoryText = JSON.stringify(snapshot);
    const toolSlice = viewsText.includes('secret-path')
      ? viewsText.slice(
          Math.max(0, viewsText.indexOf('lease_propose') - 40),
          viewsText.indexOf('secret-reason-xyz') + 40
        )
      : '';
    const lickEntries = Object.values(views)
      .flatMap((view) => view.entries ?? [])
      .filter((entry) => String(entry.kind ?? '').includes('lick'));
    const out = {
      inventory: inventoryText,
      views: viewsText,
      toolSlice,
      lickEntries: lickEntries.length,
      results: r.results(),
    };
    inventory?.dispose?.();
    await r.owner.release();
    return out;
  });
  assert.ok(seen.views.includes('secret-path'));
  assert.ok(seen.views.includes('secret-reason-xyz'));
  assert.ok(seen.toolSlice.includes('lease_propose'));
  assert.ok(!seen.inventory.includes('secret-path'));
  assert.ok(!seen.inventory.includes('secret-reason-xyz'));
  assert.equal(seen.lickEntries, 0);
  assert.equal(seen.results[0], SENT);
});

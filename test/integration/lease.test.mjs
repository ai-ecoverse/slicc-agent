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
const PROMPT =
  'lease_propose asks the owner to let a browser job read one page; it only proposes, returns no page content and reports no status.';

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
  globalThis.propose = (url, reason) => ({
    tool: { name: 'lease_propose', args: { url, reason } },
  });
  globalThis.answer = (text) => ({ answer: text });
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
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    let lives = 0;
    let worker;
    const bios = { messages: [], epoch: null };
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
                port1.start();
                port1.onmessage = ({ data }) => {
                  bios.messages.push(data);
                  if (data?.type === 'hello') bios.epoch = data.epoch;
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
  assert.match(testWorker, /holdLease: 'published'/);
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
});

test('url and reason refusals', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const cases = [
    ['https://example.com/x?q=1', 'why', QUERY],
    ['https://example.com/x?', 'why', QUERY],
    ['https://example.com/x#f', 'why', "That URL can't include a fragment."],
    ['http://example.com/x', 'why', 'Only https URLs can be proposed.'],
    ['https://user:pass@example.com/x', 'why', "That URL can't include a username or password."],
    [`https://example.com/${'a'.repeat(2100)}`, 'why', 'That URL is too long.'],
    ['https://example.com/\u0001', 'why', "That URL contains characters that aren't allowed."],
    ['https://example.com/ok', 'x'.repeat(300), 'That reason is too long.'],
    ['https://example.com/ok', 'bad\u200b', "That reason contains characters that aren't allowed."],
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
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    await r.until(
      () => r.bios.messages.some((m) => m.type === 'withdrawn' && m.reason === 'cancelled'),
      'withdrawn'
    );
    const before = r.bios.messages.length;
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    r.cancel({ v: 1, type: 'cancel', epoch: 'a'.repeat(32), proposal: proposal.proposal });
    r.cancel({ v: 1, type: 'cancel', epoch: r.bios.epoch, proposal: 99, extra: true });
    r.cancel({ v: 2, type: 'cancel', epoch: r.bios.epoch, proposal: proposal.proposal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const out = {
      withdrawn: r.bios.messages.filter((m) => m.type === 'withdrawn'),
      after: r.bios.messages.length - before,
    };
    await r.owner.release();
    return out;
  });
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
    await r.until(
      () => r.results().includes(RESTARTED) || r.said().includes('After.'),
      'resume result'
    );
    const out = {
      firstEpoch,
      secondEpoch: r.bios.epoch,
      proposals: r.bios.messages.filter((m) => m.type === 'proposal').length,
      before,
      results: r.results(),
      said: r.said(),
      hellos: r.bios.messages.filter((m) => m.type === 'hello').map((m) => m.epoch),
    };
    await r.owner.release();
    return out;
  });
  assert.equal(seen.hellos.length, 2);
  assert.notEqual(seen.firstEpoch, seen.secondEpoch);
  assert.equal(seen.proposals, 1);
  assert.equal(seen.proposals, seen.before);
  assert.ok(seen.results.includes(RESTARTED) || seen.said.includes('After.'));
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

test('a fake bios end drops another epoch proposal', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'fake bios drops', async () => {
    const { acceptWorkerMessage } = await import('/dist/lease/protocol.js');
    const kept = [];
    let epoch;
    const accept = (data) => {
      const message = acceptWorkerMessage(data, epoch);
      if (!message) return;
      if (message.type === 'hello') epoch = message.epoch;
      kept.push(message);
    };
    accept({ v: 1, type: 'hello', epoch: 'a'.repeat(32) });
    accept({
      v: 1,
      type: 'proposal',
      epoch: 'b'.repeat(32),
      proposal: 1,
      agentId: 'cone',
      url: 'https://example.com',
      reason: 'x',
      at: 1,
      expiresAt: 2,
    });
    accept({
      v: 1,
      type: 'proposal',
      epoch: 'a'.repeat(32),
      proposal: 1,
      agentId: 'cone',
      url: 'https://example.com',
      reason: 'x',
      at: 1,
      expiresAt: 2,
    });
    return kept.map((m) => m.type);
  });
  assert.deepEqual(seen, ['hello', 'proposal']);
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
    await r.until(
      () =>
        r.results().some((text) => text === GATED || /blocked|declined|gate/i.test(text)) ||
        r.said().some((text) => /Gated|blocked/i.test(text)),
      'gated outcome'
    );
    const out = {
      results: r.results(),
      said: r.said(),
      bios: r.bios.messages.filter((m) => m.type === 'proposal'),
    };
    await guest.close();
    await r.owner.release();
    return out;
  });
  assert.equal(seen.bios.length, 0);
  assert.ok(
    seen.results.some((text) => text === GATED || /blocked|declined|gate/i.test(text)) ||
      seen.said.some((text) => /Gated/i.test(text))
  );
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
    const remote = createAgentModel(r.connection, { storage: localStorage });
    await remote.agent.ready();
    const inventory = remote.inventory ? await remote.inventory() : null;
    const snapshot = inventory?.state?.value ?? inventory ?? {};
    const views = JSON.stringify(r.connection.views.value ?? {});
    const out = {
      inventory: JSON.stringify(snapshot),
      views,
      results: r.results(),
    };
    inventory?.dispose?.();
    await r.owner.release();
    return out;
  });
  assert.ok(!seen.inventory.includes('secret-path'));
  assert.ok(!seen.inventory.includes('secret-reason-xyz'));
  assert.ok(!seen.results[0].includes('secret-path'));
  assert.ok(!seen.results[0].includes('secret-reason-xyz'));
});

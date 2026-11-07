import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const answer = (text) => ({ answer: text });
const embed = (name, wait = '') => `sh /tmp/embed ${name}${wait ? ` ${wait}` : ''}`;

const REQUESTS = {
  screen: { kind: 'capture.screen', type: 'video/webm', duration: 3, microphone: true },
  still: { kind: 'capture.screen', type: 'image/png' },
  camera: { kind: 'capture.camera', type: 'image/jpeg' },
  audio: { kind: 'audio.record', gate: false, seconds: 2 },
  url: { kind: 'open.url', url: 'https://example.test/' },
};

const SCRIPT = `exec 3<>/dev/embedder
cat "/tmp/req-$1.json" >&3
if [ -n "$2" ]; then timeout "$2" cat <&3; else cat <&3; fi
echo`;

async function boot(page, { steps, judge = null, files = {} }) {
  await page.goto('/');
  await staged(
    page,
    'the capture agent',
    async ({ steps, judge, files, requests, script }) => {
      for (const [path, text] of Object.entries(files)) {
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop();
        let dir = await navigator.storage.getDirectory();
        for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(text);
        await writable.close();
      }
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const seen = [];
      const held = {};
      const hook = {
        kinds: {
          'capture.screen': {},
          'capture.camera': {},
          'audio.record': {},
          'open.url': {},
        },
        async handle({ kind, options, stamp, signal }) {
          const entry = { kind, tags: stamp.tags ?? [], answer: null, aborted: false };
          seen.push(entry);
          signal.addEventListener('abort', () => {
            entry.aborted = true;
          });
          const given = await held.owner.approveCapture({ kind, options, stamp }, { signal });
          entry.answer = given;
          return `answer: ${typeof given === 'string' ? given : JSON.stringify(given)}`;
        },
      };
      const kernel = await bootKernel();
      let worker;
      const owner = await startTracked({
        worker: () => {
          worker = new Worker(
            `/dist-test/main-worker.js?${new URLSearchParams([
              ['scoop-say', ''],
              ...(judge
                ? [['judge', ''], ...judge.map((step) => ['judge-step', JSON.stringify(step)])]
                : []),
              ...steps.map((step) => ['step', JSON.stringify(step)]),
            ])}`,
            { type: 'module' }
          );
          return worker;
        },
        kernel: { connect: () => kernel.connect({ requests: hook }) },
      });
      held.owner = owner;
      const until = (check, what) => when([changed, every(100)], check, what);
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const hub = {
        minted: 0,
        async mint() {
          this.minted += 1;
          return { id: `seat-${this.minted}`, url: `https://hub.test/join/seat-${this.minted}` };
        },
        async revoke() {},
      };
      const r = { kernel, owner, until, pause, seen };
      r.sh = (command) => kernel.run(['bash', '-c', command]);
      await r.sh(`cat > /tmp/embed <<'EOF'\n${script}\nEOF`);
      for (const [name, request] of Object.entries(requests))
        await r.sh(`printf '%s\\n' '${JSON.stringify(request)}' > /tmp/req-${name}.json`);
      r.open = async () => {
        r.local = await owner.connect();
        r.model = createAgentModel(r.local, { guests: hub });
        await r.model.agent.ready();
      };
      r.mint = async (tools, label = 'Anna') => {
        const minted = await r.model.guests.mint('cone', {
          label,
          expiresAt: null,
          gates: { messages: 'off', tools },
        });
        return minted.seat.id;
      };
      r.join = (seat, label = 'Anna') =>
        owner
          .port({ guest: { id: seat, label } })
          .then(connectGuest)
          .then(track);
      r.send = (guest, text) =>
        guest.control.send({ text, whenBusy: 'followUp', requestId: null }, BACKGROUND_CONTEXT);
      r.prompt = (text, agentId = 'cone') =>
        r.local.control.send(
          { text, whenBusy: 'followUp', requestId: null, agentId },
          BACKGROUND_CONTEXT
        );
      r.said = (agentId = 'cone') =>
        (r.local.views.value?.[agentId]?.entries ?? []).flatMap((entry) =>
          entry.kind === 'pi.assistant'
            ? (entry.model?.[0]?.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
            : []
        );
      r.captures = () => (r.local.approvals.value ?? []).filter((item) => item.kind === 'capture');
      r.pending = (count = 1) =>
        until(() => {
          const open = r.captures().filter((item) => item.state === 'pending');
          return open.length >= count && open.at(-1);
        }, 'a pending capture item');
      r.tools = () =>
        r.model.approvals
          .list()
          .filter((approval) => approval.kind === 'guest-tool')
          .map(({ id, summary }) => ({ id, summary }));
      r.allowTool = async () => {
        const [first] = await until(() => r.tools().length && r.tools(), 'a tool call to ask');
        await r.model.approvals.decide(first.id, 'once');
        return first.summary;
      };
      r.decide = (id, decision) => r.local.control.decide(id, decision, null, BACKGROUND_CONTEXT);
      r.answered = (count) =>
        until(
          () => seen.filter((entry) => entry.answer !== null).length >= count && seen,
          'the hook to answer'
        );
      r.judged = () =>
        new Promise((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = ({ data }) => resolve(data);
          worker.postMessage({ judged: port2 }, [port2]);
        });
      globalThis.r = r;
    },
    { steps, judge, files, requests: REQUESTS, script: SCRIPT }
  );
}

test('captures from runs no guest started, in a cone, a second cone and a scoop, answer once without an item or a judge call, and other kinds are denied', async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: [],
    steps: [
      bash(embed('screen')),
      answer('One.'),
      bash(embed('audio')),
      answer('Two.'),
      bash(`agent --prompt 'bash ${embed('camera')}'`),
      answer('Three.'),
      bash(embed('url')),
      answer('Four.'),
    ],
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await staged(page, 'captures from runs no guest started', async () => {
    const { until, open, prompt, said, seen, captures, owner } = globalThis.r;
    await open();
    await prompt('Capture the screen.');
    await until(() => said().includes('One.'), 'the first cone');
    const second = (await globalThis.r.local.control.createCone('second', BACKGROUND_CONTEXT)).id;
    await prompt('Record audio.', second);
    await until(() => said(second).includes('Two.'), 'the second cone');
    await prompt('Ask a scoop for a photo.');
    await until(() => said().includes('Three.'), 'the scoop');
    await prompt('Open a page.');
    await until(() => said().includes('Four.'), 'the other kind');
    const out = {
      answers: seen.map(({ kind, answer }) => [kind, answer]),
      items: captures().length,
      allItems: (globalThis.r.local.approvals.value ?? []).length,
      judged: (await globalThis.r.judged()).length,
    };
    await globalThis.r.local.close();
    await owner.release();
    out.released = await owner
      .approveCapture({ kind: 'capture.screen', options: {}, stamp: {} })
      .then(
        () => 'resolved',
        (error) => error.code
      );
    return out;
  });
  assert.deepEqual(seen.answers, [
    ['capture.screen', 'once'],
    ['audio.record', 'once'],
    ['capture.camera', 'once'],
    ['open.url', { answer: 'deny', message: 'capture: not a capture kind' }],
  ]);
  assert.equal(seen.items, 0);
  assert.equal(seen.allItems, 0);
  assert.equal(seen.judged, 0);
  assert.equal(seen.released, 'EAGAIN');
});

test("a guest's capture waits for a person on a user gate, stays out of spectrum's list, and is withdrawn when the program gives up", async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    steps: [
      bash(embed('screen')),
      answer('Recorded.'),
      bash(embed('still', 2)),
      answer('Gave up.'),
    ],
  });
  const seen = await staged(page, "a guest's capture waits for a person", async () => {
    const { until, pause, open, mint, join, send, said, seen, pending, allowTool, decide } =
      globalThis.r;
    await open();
    const seat = await mint('user');
    const guest = await join(seat);
    await send(guest, 'Record the screen.');
    const out = { tools: [await allowTool()] };
    const item = await pending();
    await pause(1000);
    out.waiting = seen.map(({ answer }) => answer);
    out.listed = globalThis.r.model.approvals.list().map((approval) => approval.kind);
    out.item = { seat: item.seat, tier: item.tier, detail: item.detail, always: item.always };
    out.requester = item.requester;
    out.decided = await decide(item.id, 'once');
    await until(() => said().includes('Recorded.'), 'the recorded run');
    out.first = seen[0].answer;
    await send(guest, 'Take a still.');
    out.tools.push(await allowTool());
    const still = await pending();
    await until(() => said().includes('Gave up.'), 'the run that gave up');
    const gone = await until(
      () =>
        globalThis.r.captures().find((entry) => entry.id === still.id && entry.state !== 'pending'),
      'the withdrawn item'
    );
    out.gone = { state: gone.state, reason: gone.reason, mode: gone.detail.mode };
    out.aborted = seen[1].aborted;
    await guest.close();
    return out;
  });
  assert.deepEqual(seen.tools, [embed('screen'), embed('still', 2)]);
  assert.deepEqual(seen.waiting, [null]);
  assert.equal(seen.listed.includes('capture'), false);
  assert.deepEqual(seen.item, {
    seat: 'seat-1',
    tier: 'user',
    detail: { what: 'screen', mode: 'video', seconds: 3, microphone: true, program: 'a program' },
    always: false,
  });
  assert.deepEqual(seen.requester, { kind: 'guest', name: 'Anna', seat: 'seat-1' });
  assert.equal(seen.decided.done, true);
  assert.equal(seen.first, 'once');
  assert.deepEqual(seen.gone, { state: 'withdrawn', reason: 'aborted', mode: 'still' });
  assert.equal(seen.aborted, true);
});

test("the judge decides a guest's capture on an agent gate from the capture's facts, and its denial reaches the program", async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: [
      { low: 0.97, aligned: 0.95 },
      { low: 0.97, aligned: 0.95 },
      { low: 0.97, aligned: 0.95 },
      { low: 0.03, aligned: 0.05 },
    ],
    steps: [bash(embed('audio')), answer('Allowed.'), bash(embed('screen')), answer('Denied.')],
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await staged(page, 'the judge decides', async () => {
    const { until, open, mint, join, send, seen, answered } = globalThis.r;
    await open();
    const seat = await mint('agent');
    await globalThis.r.local.close();
    const guest = await join(seat);
    await send(guest, 'Record a bit of audio.');
    await answered(1);
    await send(guest, 'Record the screen.');
    await answered(2);
    await open();
    await until(() => globalThis.r.said().includes('Denied.'), 'the denied run');
    const states = globalThis.r
      .captures()
      .map((item) => `${item.state}:${item.decidedBy}:${item.detail.what}`);
    const judged = (await globalThis.r.judged())
      .filter((call) => call.state.request.kind === 'capture')
      .map((call) => ({ capture: call.state.request.capture, questions: call.questions }));
    await guest.close();
    return { answers: seen.map(({ answer }) => answer), states, judged };
  });
  assert.deepEqual(seen.answers, [
    'once',
    { answer: 'deny', message: 'capture: denied by the approval judge: Faux reason.' },
  ]);
  assert.deepEqual(seen.states, ['approved:judge:microphone', 'rejected:judge:screen']);
  assert.deepEqual(seen.judged, [
    {
      capture: {
        asks: 'a recording of the microphone, for 2 seconds',
        what: 'microphone',
        mode: 'audio',
        seconds: 2,
        system: false,
        microphone: false,
      },
      questions: ['level', 'aligned', 'always'],
    },
    {
      capture: {
        asks: 'a video of the screen, window or tab the person picks, for 3 seconds, with the microphone',
        what: 'screen',
        mode: 'video',
        seconds: 3,
        system: false,
        microphone: true,
      },
      questions: ['level', 'aligned', 'always'],
    },
  ]);
});

test("Always on a guest's capture is recorded for that seat, what and mode only", async (t) => {
  const page = await chrome.page(t);
  await boot(page, {
    judge: Array.from({ length: 8 }, () => ({ low: 0.97, aligned: 0.95, always: true })),
    steps: [
      bash(embed('screen')),
      answer('First.'),
      bash(embed('screen')),
      answer('Again.'),
      bash(embed('still')),
      answer('Still.'),
      bash(embed('screen')),
      answer('Bob.'),
    ],
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await staged(page, 'Always on a guest', async () => {
    const { until, pause, open, mint, join, send, said, seen, pending, allowTool, decide } =
      globalThis.r;
    await open();
    const set = await globalThis.r.local.control.approvalPolicySet(
      { guests: { always: { tools: true } } },
      BACKGROUND_CONTEXT
    );
    const anna = await join(await mint('user'));
    await send(anna, 'Record the screen.');
    await allowTool();
    const first = await pending();
    const offered = await until(
      () => globalThis.r.captures().find((item) => item.id === first.id && item.always),
      'the Always offer'
    );
    const out = { set: set.error, offered: offered.always };
    out.decided = await decide(first.id, 'always');
    await until(() => said().includes('First.'), 'the first run');
    out.rules = (globalThis.r.local.guests.value ?? []).map((seat) =>
      seat.alwaysCaptures.map(({ what, mode }) => `${what}/${mode}`)
    );
    await send(anna, 'Again.');
    await allowTool();
    await until(() => said().includes('Again.'), 'the second run');
    out.afterAgain = globalThis.r.captures().length;
    await send(anna, 'A still.');
    await allowTool();
    const still = await pending();
    out.still = still.detail.mode;
    await decide(still.id, 'once');
    await until(() => said().includes('Still.'), 'the still run');
    await anna.close();
    const bob = await join(await mint('user', 'Bob'), 'Bob');
    await send(bob, 'Record the screen.');
    await allowTool();
    const bobs = await pending();
    out.bob = bobs.seat;
    await decide(bobs.id, 'deny');
    await until(() => said().includes('Bob.'), 'the run of Bob');
    await pause(100);
    out.answers = seen.map(({ answer }) => answer);
    await bob.close();
    return out;
  });
  assert.equal(seen.set, null);
  assert.equal(seen.offered, true);
  assert.equal(seen.decided.done, true);
  assert.deepEqual(seen.rules, [['screen/video']]);
  assert.equal(seen.afterAgain, 1);
  assert.equal(seen.still, 'still');
  assert.equal(seen.bob, 'seat-2');
  assert.deepEqual(seen.answers, ['always', 'always', 'once', 'deny']);
});

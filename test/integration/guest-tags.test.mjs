import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const answer = (text) => ({ answer: text });

async function boot(page, { steps, clock = false }) {
  await page.goto('/');
  await staged(
    page,
    'the guest-tags agent with kernel users',
    async ({ steps, clock }) => {
      const start = new Date();
      start.setDate(start.getDate() + 1);
      start.setHours(10, 59, 0, 0);
      const base = start.getTime();
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel(
        {},
        clock ? { worker: new URL(`/clock-kernel-worker.js?now=${base}`, location.href) } : {}
      );
      const owner = await startTracked({
        worker: () =>
          new Worker(
            `/dist-test/main-worker.js?${new URLSearchParams([
              ['scoop-say', ''],
              ...steps.map((step) => ['step', JSON.stringify(step)]),
            ])}`,
            { type: 'module' }
          ),
        kernel: {
          connect: (options) => kernel.connect(options?.user ? { user: options.user } : undefined),
          users: kernel.users,
        },
      });
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
      const r = { kernel, owner, until, pause, base };
      r.sh = (command, user) => kernel.run(['bash', '-c', command], user ? { user } : {});
      r.clock = (now) => new BroadcastChannel('slicc-test-clock').postMessage({ now });
      r.open = async () => {
        r.local = await owner.connect();
        r.model = createAgentModel(r.local, { guests: hub });
        await r.model.agent.ready();
        await until(
          async () => (await r.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0,
          'the cone control directory'
        );
      };
      r.guest = async () => {
        const minted = await r.model.guests.mint('cone', {
          label: 'Anna',
          expiresAt: null,
          gates: { messages: 'off', tools: 'user' },
        });
        return owner
          .port({ guest: { id: minted.seat.id, label: 'Anna' } })
          .then(connectGuest)
          .then(track);
      };
      r.send = (guest, text) =>
        guest.control.send({ text, whenBusy: 'followUp', requestId: null }, BACKGROUND_CONTEXT);
      r.said = () =>
        (r.local.views.value?.cone?.entries ?? []).flatMap((entry) =>
          entry.kind === 'pi.assistant'
            ? (entry.model?.[0]?.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
            : []
        );
      r.asked = () =>
        r.model.approvals
          .list()
          .filter((approval) => approval.kind === 'guest-tool')
          .map(({ id, summary }) => ({ id, summary }));
      r.decide = async (decision, reason) => {
        const [first] = await until(() => r.asked().length && r.asked(), 'a tool call to ask');
        await r.model.approvals.decide(first.id, decision, reason);
        await until(() => !r.asked().some((item) => item.id === first.id), 'the answer');
        return first.summary;
      };
      r.exists = async (path) => (await r.sh(`test -e ${path}`)).status === 0;
      globalThis.r = r;
    },
    { steps, clock }
  );
}

test("a guest run's background job that calls agent after the run ended still starts a gated scoop: its bash is asked, and a denied one never runs", async (t) => {
  const page = await chrome.page(t);
  const left = "(sleep 2; agent --prompt 'bash touch /tmp/late-bg') > /dev/null 2>&1 &";
  await boot(page, { steps: [bash(left), answer('Left.')] });
  const seen = await staged(page, "a guest run's background job", async () => {
    const { until, pause, open, guest, send, said, asked, decide, exists } = globalThis.r;
    await open();
    const anna = await guest();
    await send(anna, 'Leave a job behind.');
    const out = { asked: [await decide('once')] };
    await until(() => said().includes('Left.'), 'the guest run to end');
    await until(
      async () =>
        asked().some((item) => item.summary === 'touch /tmp/late-bg') ||
        (await exists('/tmp/late-bg')),
      'the late scoop'
    );
    out.ranUnasked = await exists('/tmp/late-bg');
    if (!out.ranUnasked) out.asked.push(await decide('deny', 'Not after the run.'));
    await pause(1000);
    out.ran = await exists('/tmp/late-bg');
    await anna.close();
    return out;
  });
  assert.equal(seen.ranUnasked, false);
  assert.deepEqual(seen.asked, [left, 'touch /tmp/late-bg']);
  assert.equal(seen.ran, false);
});

test("a crontab line a guest run's bash installs fires after the run as a gated cron lick: the cone run it starts has its bash asked", async (t) => {
  const page = await chrome.page(t);
  const install =
    "printf '# name: late\\n0 * * * * agent send cone --lick=cron after-run\\n' | crontab -";
  await boot(page, {
    clock: true,
    steps: [bash(install), answer('Scheduled.'), bash('echo after-lick'), answer('Licked.')],
  });
  const seen = await staged(page, 'a crontab line a guest run', async () => {
    const { until, open, guest, send, said, asked, decide, sh, clock, base } = globalThis.r;
    await open();
    const anna = await guest();
    await send(anna, 'Schedule a job.');
    const out = { asked: [await decide('once')] };
    await until(() => said().includes('Scheduled.'), 'the guest run to end');
    out.table = (await sh('crontab -l', 'cone')).stdout;
    await until(
      async () => (await sh('cat /var/spool/cron/stamp')).stdout.includes('late'),
      'the late job to be armed'
    );
    clock(base + 61_000);
    const ran = () =>
      (globalThis.r.local.views.value?.cone?.entries ?? []).some(
        (entry) => entry.kind === 'pi.tool-result' && JSON.stringify(entry).includes('after-lick')
      );
    await until(
      () => asked().some((item) => item.summary === 'echo after-lick') || ran(),
      'the cone run the cron lick starts'
    );
    out.ranUnasked = ran();
    if (!out.ranUnasked) out.asked.push(await decide('once'));
    await until(() => said().includes('Licked.'), 'the licked run');
    await anna.close();
    return out;
  });
  assert.match(seen.table, /agent send cone --lick=cron after-run/);
  assert.equal(seen.ranUnasked, false);
  assert.deepEqual(seen.asked, [install, 'echo after-lick']);
});

test("a guest run's bash can't replay a clean agent call that is running: a request naming that call's pid starts a gated scoop, and the clean scoop isn't asked", async (t) => {
  const page = await chrome.page(t);
  const prompt = 'bash touch /tmp/replay-$$; while [ ! -e /tmp/release ]; do sleep 0.2; done';
  const forge = [
    'pid=$(cat /tmp/clean-pid)',
    'dir=/var/lib/slicc/agent/requests/cone',
    'id=forged-$$',
    `printf '%s\\0' slicc-agent/2 agent '' / "$pid" '' 2 --prompt '${prompt}' > $dir/in/.tmp-$id`,
    'mv $dir/in/.tmp-$id $dir/in/$id',
  ].join('; ');
  await boot(page, { steps: [bash(forge), answer('Forged.')] });
  const seen = await staged(
    page,
    "a guest run's bash can't replay",
    async (prompt) => {
      const { until, pause, open, guest, send, said, asked, decide, sh } = globalThis.r;
      await open();
      const clean = sh(`echo $$ > /tmp/clean-pid; exec agent --prompt '${prompt}'`, 'cone');
      const started = async () =>
        Number((await sh('set -- /tmp/replay-*; [ -e "$1" ] && echo $# || echo 0')).stdout);
      await until(async () => (await started()) === 1, 'the clean scoop');
      const out = { cleanAsked: asked().length };
      const answered = async () =>
        (await sh('cat /var/lib/slicc/agent/requests/cone/out/forged-*.out 2>/dev/null')).stdout;
      const anna = await guest();
      await send(anna, 'Replay it.');
      out.asked = [await decide('once')];
      await until(() => said().includes('Forged.'), 'the forging run');
      await until(
        async () =>
          asked().some((item) => item.summary === prompt.slice(5)) ||
          (await started()) > 1 ||
          (await answered()),
        'the replayed scoop'
      );
      await pause(500);
      out.starts = await started();
      out.answer = await answered();
      if (out.starts === 1) out.asked.push(await decide('deny', 'A replay.'));
      await sh('touch /tmp/release');
      out.clean = (await clean).status;
      await pause(500);
      out.after = await started();
      await anna.close();
      return out;
    },
    prompt
  );
  assert.equal(seen.cleanAsked, 0);
  assert.equal(seen.starts, 1);
  assert.equal(seen.asked.length, 2);
  assert.equal(seen.asked[1], prompt.slice(5));
  assert.equal(seen.clean, 0);
  assert.equal(seen.after, 1);
});

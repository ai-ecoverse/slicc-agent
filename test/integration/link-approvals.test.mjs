import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const answer = (text) => ({ answer: text });

async function boot(page, steps) {
  await page.goto('/');
  await staged(
    page,
    'the linked-approvals agent',
    async ({ steps }) => {
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const held = {};
      const kernel = await bootKernel(
        {},
        { users: 'enforce', approve: (req, options) => held.owner.approve(req, options) }
      );
      await kernel.users.add({ name: 'cone', groups: ['sudo'] });
      const query = new URLSearchParams([
        ['scoop-say', ''],
        ...steps.map((step) => ['step', JSON.stringify(step)]),
      ]);
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
        kernel: {
          connect: (options) =>
            kernel.connect(
              options?.user
                ? {
                    user: options.user,
                    tag: JSON.stringify({ kind: 'agent', agentId: options.agentId }),
                  }
                : undefined
            ),
          users: kernel.users,
          groups: kernel.groups,
        },
      });
      held.owner = owner;
      const until = (check, what) => when([changed, every(100)], check, what);
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const r = { kernel, owner, until, pause };
      r.open = async () => {
        r.local = await owner.connect();
        r.remote = remoteControl(r.local, { device: 'node-7' });
        const opened = await r.remote.approvals({ watch: true });
        r.snapshots = [opened.approvals];
        r.stopWatch = () => opened.events[Symbol.asyncIterator]().return();
        void (async () => {
          for await (const snapshot of opened.events) r.snapshots.push(snapshot);
        })();
      };
      r.latest = () => r.snapshots.at(-1);
      r.attempt = (id, answer, reason) =>
        r.remote.decide({ id, answer, reason }).then(
          (result) => result,
          (error) => ({ code: error.code, message: error.message })
        );
      r.record = (id) => {
        const item = r.local.approvals.value.find((entry) => entry.id === id);
        return {
          state: item.state,
          decidedBy: item.decidedBy,
          device: item.device ?? null,
          reason: item.reason ?? null,
        };
      };
      r.view = (agentId) => (agentId ? r.local.views.value?.[agentId] : r.local.views.value?.cone);
      r.texts = (kind, agentId) =>
        (r.view(agentId)?.entries ?? [])
          .filter((entry) => entry.kind === kind)
          .map((entry) =>
            (entry.model?.[0]?.content ?? [])
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('')
              .trim()
          );
      globalThis.r = r;
    },
    { steps }
  );
}

test('a linked device lists pending sudo and guest-tool approvals, answers them as a follower, and is refused with the agent’s sentence', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [bash('echo guest-once'), answer('Guest ran.')]);
  const seen = await staged(page, 'linked approvals', async () => {
    const r = globalThis.r;
    await r.open();
    const empty = r.latest();
    await r.local.control.guestOpen(
      {
        id: 'seat-1',
        label: 'Anna',
        agentId: 'cone',
        expiresAt: null,
        gates: { messages: 'off', tools: 'user' },
      },
      BACKGROUND_CONTEXT
    );
    const guest = await r.owner
      .port({ guest: { id: 'seat-1', label: 'Anna' } })
      .then(connectGuest)
      .then(track);
    await guest.control.send(
      { text: 'Run something.', whenBusy: 'followUp', requestId: null },
      BACKGROUND_CONTEXT
    );
    await r.until(() => r.latest().length === 1, 'the guest tool call');
    const terminal = r.kernel.run(['sudo', 'ls', '/root'], {
      user: 'cone',
      tag: JSON.stringify({ kind: 'user', where: 'terminal:3' }),
    });
    await r.until(
      () => r.latest().length === 2 && !r.latest().some((item) => item.judging),
      'the terminal sudo, judged'
    );
    const listed = r.latest();
    const once = await r.remote.approvals();
    const [tool, sudo] = listed;
    const always = await r.attempt(tool.id, 'always');
    const pendingAfterAlways = r.record(tool.id).state;
    const approved = await r.attempt(tool.id, 'once');
    const again = await r.attempt(tool.id, 'deny');
    const stop = await r.attempt(sudo.id, 'stop');
    const odd = await r.attempt(sudo.id, 'maybe');
    const denied = await r.attempt(sudo.id, 'deny', 'Not from here.');
    const unknown = await r.attempt('apr-missing', 'once');
    const viewer = await r.owner.connect({ readOnly: true });
    const viewed = await remoteControl(viewer, { device: 'node-9' })
      .decide({ id: tool.id, answer: 'deny' })
      .then(
        (result) => result,
        (error) => ({ code: error.code })
      );
    await viewer.close();
    const terminalRun = await terminal;
    await r.until(() => r.texts('pi.assistant').includes('Guest ran.'), 'the guest run');
    await r.until(() => r.latest().length === 0, 'an empty snapshot');
    const out = {
      empty,
      listed,
      once,
      always,
      pendingAfterAlways,
      approved,
      again,
      stop,
      odd,
      denied,
      unknown,
      viewed,
      terminalStatus: terminalRun.status,
      toolRecord: r.record(tool.id),
      sudoRecord: r.record(sudo.id),
      results: r.texts('pi.tool-result'),
      last: r.latest(),
    };
    await r.stopWatch();
    await guest.close();
    await r.local.close();
    await r.owner.release();
    return out;
  });
  assert.deepEqual(seen.empty, []);
  assert.deepEqual(seen.once, { approvals: seen.listed });
  const [tool, sudo] = seen.listed;
  assert.equal(tool.kind, 'guest-tool');
  assert.equal(tool.tier, 'user');
  assert.equal(tool.agentId, 'cone');
  assert.equal(tool.always, false);
  assert.equal(tool.stoppable, false);
  assert.deepEqual(tool.requester, { kind: 'guest', name: 'Anna' });
  assert.equal(tool.detail.tool, 'bash');
  assert.equal(tool.detail.summary, 'echo guest-once');
  assert.equal(sudo.kind, 'sudo');
  assert.equal(sudo.tier, 'user');
  assert.equal(sudo.always, false);
  assert.equal(sudo.stoppable, false);
  assert.equal(sudo.requester.kind, 'user');
  assert.equal(sudo.requester.where, 'a terminal');
  assert.match(sudo.detail.command, /ls \/root/);
  assert.ok(tool.createdAt <= sudo.createdAt);
  for (const item of seen.listed) {
    for (const key of ['replay', 'run', 'seat', 'device', 'state', 'decidedBy'])
      assert.equal(key in item, false, `${key} stays in the worker`);
    assert.equal('seat' in item.requester, false);
    assert.equal('device' in item.requester, false);
    assert.equal('agentId' in item.requester, false);
  }
  assert.deepEqual(seen.always, {
    code: 'EINVAL',
    message: "EINVAL: Always isn't offered for this request.",
  });
  assert.equal(seen.pendingAfterAlways, 'pending');
  assert.deepEqual(seen.approved, { ok: true });
  assert.deepEqual(seen.again, {
    code: 'EINVAL',
    message: 'EINVAL: Someone else already answered this.',
  });
  assert.deepEqual(seen.stop, {
    code: 'EINVAL',
    message: 'EINVAL: This request has no turn to stop.',
  });
  assert.deepEqual(seen.odd, {
    code: 'EINVAL',
    message: 'EINVAL: An answer is once, always, deny or stop.',
  });
  assert.deepEqual(seen.denied, { ok: true });
  assert.deepEqual(seen.unknown, {
    code: 'ENOENT',
    message: 'ENOENT: There is no approval apr-missing.',
  });
  assert.deepEqual(seen.viewed, { code: 'EACCES' });
  assert.notEqual(seen.terminalStatus, 0);
  assert.deepEqual(seen.toolRecord, {
    state: 'approved',
    decidedBy: 'follower',
    device: 'node-7',
    reason: null,
  });
  assert.deepEqual(seen.sudoRecord, {
    state: 'rejected',
    decidedBy: 'follower',
    device: 'node-7',
    reason: 'Not from here.',
  });
  assert.equal(seen.results.at(-1), 'guest-once');
  assert.deepEqual(seen.last, []);
});

test("a linked device's stop on a scoop's sudo stops the scoop's turn, and the cone carries on", async (t) => {
  const page = await chrome.page(t);
  const loop = 'bash while true; do sudo ls /root; echo x >> /tmp/link-loop; done';
  await boot(page, [
    bash(`agent --name helper --prompt '${loop}'`),
    answer('The cone carried on.'),
  ]);
  const seen = await staged(page, "a linked stop on a scoop's sudo", async () => {
    const r = globalThis.r;
    await r.open();
    const rule = '%cone (root) Cmnd /usr/bin/ls /root';
    await r.kernel.run(
      ['bash', '-c', `echo '${rule}' > /etc/sudoers.d/scoops && chmod 440 /etc/sudoers.d/scoops`],
      {}
    );
    await r.local.control.send(
      { text: 'Have a helper loop sudo.', whenBusy: 'followUp', requestId: null, agentId: 'cone' },
      BACKGROUND_CONTEXT
    );
    const asked = await r.until(
      () => r.latest().find((item) => item.kind === 'sudo'),
      "the scoop's sudo"
    );
    const stopped = await r.attempt(asked.id, 'stop');
    await r.until(
      () => r.texts('pi.assistant').includes('The cone carried on.'),
      'the cone to carry on'
    );
    const lines = async () =>
      (
        await r.kernel.run(['bash', '-c', 'cat /tmp/link-loop 2>/dev/null | wc -l'], {})
      ).stdout.trim();
    const counted = await lines();
    await r.pause(1500);
    const later = await lines();
    const out = {
      asked,
      stopped,
      record: r.record(asked.id),
      counted,
      later,
      coneResults: r.texts('pi.tool-result'),
    };
    await r.stopWatch();
    await r.local.close();
    await r.owner.release();
    return out;
  });
  assert.equal(seen.asked.stoppable, true);
  assert.equal(seen.asked.requester.kind, 'agent');
  assert.equal(seen.asked.requester.name, 'helper');
  assert.deepEqual(seen.stopped, { ok: true });
  assert.deepEqual(seen.record, {
    state: 'rejected',
    decidedBy: 'follower',
    device: 'node-7',
    reason: 'stopped',
  });
  assert.equal(seen.later, seen.counted, "the scoop's loop ended");
  assert.match(seen.coneResults.at(-1), /ended without an answer: aborted/);
});

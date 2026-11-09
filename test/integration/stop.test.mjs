import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const STOPPED = 'sudo: denied, and the owner stopped this turn';
const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const answer = (text) => ({ answer: text });

async function boot(page, steps) {
  await page.goto('/');
  await staged(
    page,
    'the deny-and-stop agent',
    async (steps) => {
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const replies = [];
      const held = {};
      const kernel = await bootKernel(
        {},
        {
          users: 'enforce',
          approve: (req, options) => {
            const reply = held.owner.approve(req, options);
            reply.then(
              (answer) => replies.push(answer),
              () => undefined
            );
            return reply;
          },
        }
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
      const r = { kernel, owner, replies, until, pause };
      r.lines = async (path) =>
        (await kernel.run(['bash', '-c', `cat ${path} 2>/dev/null | wc -l`], {})).stdout.trim();
      r.open = async () => {
        r.local = await owner.connect();
        r.model = createAgentModel(r.local);
        await r.model.agent.ready();
      };
      r.sudoItems = () => r.local.approvals.value.filter((item) => item.kind === 'sudo');
      r.shown = (agentId) =>
        until(
          () =>
            r.model.approvals
              .list()
              .find(
                (approval) => approval.kind === 'sudo' && approval.requester.agentId === agentId
              ),
          `a sudo request from ${agentId}`
        );
      r.pick = ({ state, decidedBy, reason }) => ({ state, decidedBy, reason: reason ?? null });
      r.idle = (agentId) =>
        until(
          () => {
            const view = agentId ? r.local.views.value?.[agentId] : r.local.transcript.value;
            return view && !view.docs?.['pi.live']?.run;
          },
          `${agentId ?? 'the cone'} to be idle`
        );
      r.toolResults = (agentId) => {
        const view = agentId ? r.local.views.value?.[agentId] : r.local.transcript.value;
        return (view?.entries ?? [])
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === 'toolResult')
          .map((message) => message.content.map((part) => part.text ?? '').join(''));
      };
      r.said = (agentId) => {
        const view = agentId ? r.local.views.value?.[agentId] : r.local.transcript.value;
        return (view?.entries ?? []).flatMap((entry) =>
          entry.kind === 'pi.assistant'
            ? (entry.model?.[0]?.content ?? [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
            : []
        );
      };
      globalThis.r = r;
    },
    steps
  );
}

test("deny and stop ends the cone's turn and the shell loop that keeps asking for sudo, records the denial, and a terminal's sudo can't be stopped", async (t) => {
  const page = await chrome.page(t);
  const loop = 'while true; do sudo ls /root; echo x >> /tmp/loop; done';
  await boot(page, [bash(loop), answer('Back again.')]);
  const seen = await staged(page, 'deny and stop on a cone', async () => {
    const r = globalThis.r;
    await r.open();
    const terminal = r.kernel.run(['sudo', 'ls', '/root'], {
      user: 'cone',
      tag: JSON.stringify({ kind: 'user', where: 'terminal:3' }),
    });
    const fromTerminal = await r.until(
      () => r.model.approvals.list().find((approval) => approval.kind === 'sudo'),
      'the terminal request'
    );
    const refused = await r.model.approvals.decide(fromTerminal.id, 'stop').then(
      () => 'decided',
      (error) => error.message
    );
    const stillPending = r.local.approvals.value.find((item) => item.id === fromTerminal.id).state;
    await r.model.approvals.decide(fromTerminal.id, 'deny');
    const terminalRun = await terminal;
    await r.model.agent.send(r.model.agent.active(), 'Loop sudo.');
    const asked = await r.shown('cone');
    await r.model.approvals.decide(asked.id, 'stop');
    const afterDecide = r.sudoItems().map((item) => ({ id: item.id, ...r.pick(item) }));
    await r.idle();
    const counted = await r.lines('/tmp/loop');
    await r.pause(1500);
    const later = await r.lines('/tmp/loop');
    const ps = (await r.kernel.run(['ps', '-e', '-o', 'args'], {})).stdout;
    const items = r.sudoItems().map((item) => ({ id: item.id, ...r.pick(item) }));
    const listed = r.model.approvals.list().length;
    await r.model.agent.send(r.model.agent.active(), 'Are you there?');
    await r.until(() => r.said().includes('Back again.'), 'the next turn');
    await r.local.close();
    await r.owner.release();
    return {
      shownTerminal: fromTerminal.stoppable ?? null,
      refused,
      stillPending,
      terminalStatus: terminalRun.status,
      asked,
      afterDecide,
      counted,
      later,
      looping: ps.includes('while true'),
      items,
      listed,
      replies: r.replies,
      said: r.said(),
    };
  });
  assert.equal(seen.shownTerminal, null);
  assert.equal(seen.refused, 'This request has no turn to stop.');
  assert.equal(seen.stillPending, 'pending');
  assert.notEqual(seen.terminalStatus, 0);
  assert.equal(seen.asked.stoppable, true);
  assert.deepEqual(seen.asked.requester, { kind: 'agent', name: 'sliccy', agentId: 'cone' });
  const stopped = seen.items.find((item) => item.id === seen.asked.id);
  assert.deepEqual(stopped, {
    id: seen.asked.id,
    state: 'rejected',
    decidedBy: 'owner',
    reason: 'stopped',
  });
  assert.equal(
    seen.afterDecide.some((item) => item.state === 'pending'),
    false,
    'nothing from the stopped turn is left for a person'
  );
  for (const item of seen.items.slice(2))
    assert.deepEqual(
      { state: item.state, decidedBy: item.decidedBy, reason: item.reason },
      { state: 'withdrawn', decidedBy: 'host', reason: 'stopped' }
    );
  assert.ok(seen.items.length <= 3, `at most one more ask slips in: ${JSON.stringify(seen.items)}`);
  assert.equal(seen.later, seen.counted, 'the loop ended');
  assert.equal(seen.looping, false);
  assert.equal(seen.listed, 0);
  assert.deepEqual(seen.replies.slice(1, 2), [{ answer: 'deny', message: STOPPED }]);
  assert.equal(seen.said.at(-1), 'Back again.');
});

test("deny and stop on a scoop's sudo stops the scoop's turn, not its cone's, and the cone waiting on it hears the scoop ended without an answer", async (t) => {
  const page = await chrome.page(t);
  const loop = 'bash while true; do sudo ls /root; echo x >> /tmp/scoop-loop; done';
  await boot(page, [
    bash(`agent --name helper --prompt '${loop}'`),
    answer('The cone carried on.'),
  ]);
  const seen = await staged(page, "deny and stop on a scoop's sudo", async () => {
    const r = globalThis.r;
    await r.open();
    const rule = '%cone (root) Cmnd /usr/bin/ls /root';
    await r.kernel.run(
      ['bash', '-c', `echo '${rule}' > /etc/sudoers.d/scoops && chmod 440 /etc/sudoers.d/scoops`],
      {}
    );
    await r.model.agent.send(r.model.agent.active(), 'Have a helper loop sudo.');
    const asked = await r.until(
      () =>
        r.model.approvals
          .list()
          .find(
            (approval) =>
              approval.kind === 'sudo' && approval.requester.agentId?.startsWith('scoop:')
          ),
      "the scoop's sudo"
    );
    await r.model.approvals.decide(asked.id, 'stop');
    await r.until(() => r.said().includes('The cone carried on.'), 'the cone to carry on');
    const counted = await r.lines('/tmp/scoop-loop');
    await r.pause(1500);
    const later = await r.lines('/tmp/scoop-loop');
    const item = r.local.approvals.value.find((entry) => entry.id === asked.id);
    const result = {
      asked,
      item: r.pick(item),
      counted,
      later,
      coneResults: r.toolResults(),
      replies: r.replies,
    };
    await r.local.close();
    await r.owner.release();
    return result;
  });
  assert.equal(seen.asked.stoppable, true);
  assert.equal(seen.asked.requester.name, 'helper');
  assert.deepEqual(seen.item, { state: 'rejected', decidedBy: 'owner', reason: 'stopped' });
  assert.equal(seen.later, seen.counted, "the scoop's loop ended");
  assert.deepEqual(seen.replies[0], { answer: 'deny', message: STOPPED });
  assert.match(seen.coneResults.at(-1), /ended without an answer: aborted/);
});

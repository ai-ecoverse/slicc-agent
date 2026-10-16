import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

async function boot(page, { worker = 'agent-worker.js', query = '', files = {} } = {}) {
  await page.goto('/');
  await page.evaluate(
    async (worker, query, files) => {
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
      const asked = [];
      const held = {};
      const kernel = await bootKernel(
        {},
        {
          users: 'enforce',
          approve: (req, options) => {
            asked.push(req.id);
            const where = req.tag?.includes('follower:') ? 'on Pat’s phone' : undefined;
            return held.owner.approve(req, { ...options, ...(where ? { where } : {}) });
          },
        }
      );
      await kernel.users.add({ name: 'cone', groups: ['sudo'] });
      let running;
      const owner = await startAgent({
        worker: () => {
          running = new Worker(`/dist-test/${worker}${query}`, { type: 'module' });
          return running;
        },
        ...(worker === 'main-worker.js' ? { kernel: { connect: () => kernel.connect() } } : {}),
      });
      held.owner = owner;
      const MIB = 1024 * 1024;
      const sink = (channel) => {
        const queue = [];
        const pump = () => {
          while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < MIB)
            channel.send(queue.shift());
        };
        channel.onbufferedamountlow = pump;
        return {
          write(bytes) {
            queue.push(bytes.slice());
            pump();
          },
          close() {
            if (channel.readyState === 'open') channel.close();
          },
        };
      };
      const pump = (channel, end) => {
        channel.binaryType = 'arraybuffer';
        channel.onmessage = ({ data }) => end.receive(new Uint8Array(data));
        channel.onclose = () => end.end();
      };
      const follow = async (device, readOnly = false) => {
        const a = new RTCPeerConnection();
        const b = new RTCPeerConnection();
        a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate);
        b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate);
        const ours = a.createDataChannel('pi', { ordered: true });
        const theirs = new Promise((resolve) => {
          b.ondatachannel = ({ channel }) => resolve(channel);
        });
        await a.setLocalDescription();
        await b.setRemoteDescription(a.localDescription);
        await b.setLocalDescription();
        await a.setRemoteDescription(b.localDescription);
        const other = await theirs;
        for (const channel of [ours, other])
          if (channel.readyState !== 'open')
            await new Promise((resolve) =>
              channel.addEventListener('open', resolve, { once: true })
            );
        const port = await owner.port({ pages: false, device, ...(readOnly ? { readOnly } : {}) });
        pump(ours, bridgePort(port, sink(ours)));
        const endpoint = linkEndpoint(sink(other));
        pump(other, endpoint);
        return connectAgent(endpoint);
      };
      const until = async (check, what) => {
        for (let i = 0; i < 400; i++) {
          const value = await check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`timed out waiting for ${what}`);
      };
      const sudoItems = (connection) =>
        connection.approvals.value.filter((item) => item.kind === 'sudo');
      const newest = (connection) => sudoItems(connection).at(-1);
      const pending = (connection, count) =>
        until(
          () => sudoItems(connection).filter((item) => item.state === 'pending').length >= count,
          'a pending sudo approval'
        );
      const sudo = (argv, tag, extra = {}) =>
        kernel.run(['sudo', ...argv], { user: 'cone', ...(tag ? { tag } : {}), ...extra });
      const tags = {
        cone: JSON.stringify({ kind: 'agent', agentId: 'cone:cone' }),
        terminal: JSON.stringify({ kind: 'user', where: 'terminal:7' }),
        phone: JSON.stringify({ kind: 'user', where: 'follower:phone-9' }),
      };
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const client = async (tag) => attachKernel(await kernel.connect({ user: 'cone', tag }));
      const call = (message) =>
        new Promise((resolve) => {
          const { port1, port2 } = new MessageChannel();
          port1.onmessage = ({ data }) => resolve(data);
          running.postMessage({ ...message(port2) }, [port2]);
        });
      const ask = async (draft) => (await call((reply) => ({ approve: draft, reply }))).item;
      const judged = () => call((port) => ({ judged: port }));
      const setTable = (judgeTable) => running.postMessage({ judgeTable });
      globalThis.t = {
        kernel,
        ask,
        judged,
        setTable,
        owner,
        asked,
        follow,
        until,
        sudoItems,
        newest,
        pending,
        sudo,
        tags,
        client,
      };
    },
    worker,
    query,
    files
  );
}

test("a cone's sudo waits in the agent's approvals, and every owner device answers it with the owner's powers, Always included, even without Control", async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, asked, follow, until, newest, pending, sudo, tags } = globalThis.t;
    const local = await owner.connect();
    const phone = await follow('phone-1');
    const tablet = await follow('tablet-1', true);
    const mine = createAgentModel(local);
    const theirs = createAgentModel(phone);
    const watching = createAgentModel(tablet);
    const first = sudo(['ls', '/root'], tags.cone);
    await pending(local, 1);
    const id = newest(local).id;
    await until(
      () => [mine, theirs].every((model) => model.approvals.list().some((a) => a.id === id)),
      'both pages to list it'
    );
    const ownerShown = mine.approvals.list().find((approval) => approval.id === id);
    const followerShown = theirs.approvals.list().find((approval) => approval.id === id);
    await theirs.approvals.decide(id, 'once');
    const ran = await first;
    const once = newest(local);
    const second = sudo(['ls', '/root'], tags.cone);
    await pending(local, 1);
    const again = newest(local).id;
    await until(() => watching.approvals.list().some((a) => a.id === again), 'the second ask');
    const viewShown = watching.approvals.list().find((approval) => approval.id === again);
    await watching.approvals.decide(again, 'always');
    const secondRan = await second;
    const always = newest(local);
    const third = await sudo(['ls', '/root'], tags.cone);
    const count = asked.length;
    await phone.close();
    await tablet.close();
    await local.close();
    await owner.release();
    return {
      ownerShown,
      followerShown,
      viewShown,
      readOnly: tablet.readOnly,
      status: [ran.status, secondRan.status, third.status],
      once,
      always,
      count,
    };
  });
  assert.deepEqual(seen.ownerShown, {
    id: seen.once.id,
    kind: 'sudo',
    requester: { kind: 'agent', name: 'sliccy', agentId: 'cone' },
    command: '/usr/bin/ls /root',
    target: 'root',
    cwd: '/',
    createdAt: seen.once.createdAt,
    expiresAt: seen.once.expiresAt,
    always: true,
    alwaysScope: 'cwd',
  });
  assert.deepEqual(seen.followerShown, seen.ownerShown);
  assert.equal(seen.once.answer, 'once');
  assert.equal(seen.once.decidedBy, 'follower');
  assert.equal(seen.once.device, 'phone-1');
  assert.equal(seen.readOnly, true);
  assert.equal(seen.viewShown.always, true);
  assert.equal(seen.viewShown.alwaysScope, 'cwd');
  assert.equal(seen.always.answer, 'always');
  assert.equal(seen.always.decidedBy, 'follower');
  assert.equal(seen.always.device, 'tablet-1');
  assert.deepEqual(seen.status, [0, 0, 0]);
  assert.equal(seen.count, 2);
});

test('the requester comes from the process tag, a person saying no denies sudo, and a user still has one request at a time', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, newest, pending, sudo, tags } = globalThis.t;
    const local = await owner.connect();
    const model = createAgentModel(local);
    const requesters = [];
    const results = [];
    for (const tag of [tags.terminal, tags.phone, null]) {
      const running = sudo(['ls', '/root'], tag);
      await pending(local, 1);
      const item = newest(local);
      requesters.push(item.requester);
      if (tag === tags.terminal) results.push(await sudo(['ls', '/'], tags.cone));
      await model.approvals.decide(item.id, 'deny');
      results.push(await running);
    }
    const states = local.approvals.value.map(({ state, decidedBy }) => ({ state, decidedBy }));
    await local.close();
    await owner.release();
    return { requesters, results, states };
  });
  assert.deepEqual(seen.requesters, [
    { kind: 'user', name: 'cone', where: 'a terminal' },
    { kind: 'user', name: 'cone', where: 'on Pat’s phone', device: 'phone-9' },
    { kind: 'user', name: 'cone' },
  ]);
  assert.match(seen.results[0].stderr, /another request is pending/);
  for (const result of seen.results.slice(1)) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval denied/);
  }
  assert.deepEqual(seen.states, [
    { state: 'rejected', decidedBy: 'owner' },
    { state: 'rejected', decidedBy: 'owner' },
    { state: 'rejected', decidedBy: 'owner' },
  ]);
});

test('a sudo whose requester gives up is withdrawn, and a reload of the agent withdraws the open one and denies it', async (t) => {
  const page = await chrome.page(t);
  await boot(page, { query: `?directory=/sudo-${Date.now()}` });
  const seen = await page.evaluate(async () => {
    const { owner, until, newest, pending, sudo, tags, client } = globalThis.t;
    let local = await owner.connect();
    const model = createAgentModel(local);
    const ended = [];
    model.approvals.on('ended', (detail) => ended.push(detail));
    const shell = await client(tags.terminal);
    const process = await shell.spawn(['sudo', 'ls', '/root'], {});
    await pending(local, 1);
    const gaveUp = newest(local).id;
    process.signal('SIGINT');
    await process.ended;
    await until(() => newest(local).state === 'withdrawn', 'the withdrawal');
    const withdrawn = newest(local);
    await until(() => ended.length, 'the page to hear it ended');
    const running = sudo(['ls', '/root'], tags.cone);
    await pending(local, 1);
    const open = newest(local).id;
    await local.close();
    await owner.restart();
    const result = await running;
    local = await owner.connect();
    await until(() => local.approvals.value.some((item) => item.id === open), 'the record');
    const reloaded = local.approvals.value.find((item) => item.id === open);
    await shell.close();
    await local.close();
    await owner.release();
    return { gaveUp, withdrawn, ended, result, reloaded };
  });
  assert.equal(seen.withdrawn.id, seen.gaveUp);
  assert.equal(seen.withdrawn.reason, 'withdrawn');
  assert.deepEqual(seen.ended, [{ id: seen.gaveUp, reason: 'withdrawn' }]);
  assert.notEqual(seen.result.status, 0);
  assert.match(seen.result.stderr, /approval denied/);
  assert.equal(seen.reloaded.state, 'withdrawn');
  assert.equal(seen.reloaded.reason, 'restart');
});

test('without a running agent, owner.approve refuses with EAGAIN before anything is recorded, so bios can ask in its own dialog', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, sudo, tags } = globalThis.t;
    await owner.release();
    const refused = await owner
      .approve({
        id: 'sudo-1',
        kind: 'sudo',
        user: 'cone',
        argv: ['ls'],
        expiresAt: Date.now() + 60_000,
      })
      .then(
        () => null,
        (error) => error.code
      );
    const result = await sudo(['ls', '/root'], tags.terminal);
    return { refused, status: result.status };
  });
  assert.equal(seen.refused, 'EAGAIN');
  assert.notEqual(seen.status, 0);
});

test("a scoop's sudo tells its cone with a lick that has no actions", async (t) => {
  const page = await chrome.page(t);
  await boot(page, { worker: 'main-worker.js', query: '?answer=Noted.&answer=Noted.' });
  const seen = await page.evaluate(async () => {
    const { owner, until, newest, pending, sudo } = globalThis.t;
    const local = await owner.connect();
    const model = createAgentModel(local);
    await model.agent.ready();
    const scoop = await local.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const tag = JSON.stringify({ kind: 'agent', agentId: scoop.id });
    const running = sudo(['ls', '/root'], tag);
    await pending(local, 1);
    const item = newest(local);
    const lick = await until(() => {
      const texts = local.transcript.value.entries.map((entry) => JSON.stringify(entry));
      return texts.find((text) => text.includes('channel=\\"sudo-request\\"'));
    }, 'the lick');
    await model.approvals.decide(item.id, 'deny');
    await running;
    await local.close();
    await owner.release();
    return { requester: item.requester, lick };
  });
  assert.deepEqual(seen.requester, {
    kind: 'agent',
    name: 'helper',
    agentId: seen.requester.agentId,
  });
  assert.match(seen.requester.agentId, /^scoop:/);
  assert.match(seen.lick, /helper asked to run \/usr\/bin\/ls \/root as root in \//);
  assert.doesNotMatch(seen.lick, /actions=/);
});

test("with the judge on, sudo waits for a person by default, even when asked for on the agent tier, and the judge decides it only when the owner's policy says agent", async (t) => {
  const page = await chrome.page(t);
  const allow = encodeURIComponent(JSON.stringify({ low: 0.99, aligned: 0.99 }));
  await boot(page, {
    worker: 'main-worker.js',
    query: `?judge&judge-step=${allow}&judge-step=${allow}&judge-step=${allow}&answer=Noted.&answer=Noted.`,
    files: {
      '/home/.pi/agent/settings.json': JSON.stringify({ approvals: { judgeModel: 'judge/j-1' } }),
    },
  });
  const seen = await page.evaluate(async () => {
    const { owner, ask, judged, setTable, until, newest, pending, sudo, tags } = globalThis.t;
    const local = await owner.connect();
    const model = createAgentModel(local);
    await model.agent.ready();
    const guest = await ask({
      kind: 'guest-message',
      seat: 'seat-1',
      agentId: 'cone',
      requester: { kind: 'guest', name: 'Pat', seat: 'seat-1' },
      tier: 'agent',
      detail: { text: 'Fix the typo, please.', attachments: [] },
    });
    await until(
      () => local.approvals.value.find((item) => item.id === guest.id)?.state === 'approved',
      'the judge to answer the guest'
    );
    const running = sudo(['ls', '/root'], tags.cone);
    await pending(local, 1);
    const kernelItem = newest(local);
    const forced = await ask({
      kind: 'sudo',
      agentId: 'cone',
      requester: { kind: 'agent', name: 'sliccy', agentId: 'cone' },
      tier: 'agent',
      always: true,
      detail: { command: '/usr/bin/ls /root', target: 'root', cwd: '/' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const waiting = [kernelItem.id, forced.id].map((id) => {
      const { state, tier, decidedBy, verdict } = local.approvals.value.find((i) => i.id === id);
      return { state, tier, decidedBy, verdict: verdict ?? null };
    });
    const listed = [kernelItem.id, forced.id].every((id) =>
      model.approvals.list().some((approval) => approval.id === id)
    );
    const calls = (await judged()).length;
    await model.approvals.decide(kernelItem.id, 'once');
    await model.approvals.decide(forced.id, 'deny');
    const result = await running;
    const decided = [kernelItem.id, forced.id].map(
      (id) => local.approvals.value.find((item) => item.id === id).decidedBy
    );
    await local.control.approvalPolicySet({ sudo: { approver: 'agent' } }, BACKGROUND_CONTEXT);
    await until(() => local.approvalPolicy?.value?.sudo?.approver === 'agent', 'the policy');
    const judgedRun = await sudo(['ls', '/root'], tags.cone);
    const byJudge = newest(local);
    const seenByJudge = await judged();
    const after = seenByJudge.length;
    const context = seenByJudge.at(-1).state.request.sudo;
    const scoop = await local.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const scoopTag = JSON.stringify({ kind: 'agent', agentId: scoop.id });
    setTable({
      '/usr/bin/ls /tmp': { low: 0.5, aligned: 0.5 },
      '/usr/bin/ls /etc': { low: 0.99, aligned: 0.99 },
    });
    const licks = () =>
      local.transcript.value.entries
        .map((entry) => JSON.stringify(entry))
        .filter((text) => text.includes('channel=\\"sudo-request\\"'));
    const allowed = await sudo(['ls', '/etc'], scoopTag);
    const unsure = sudo(['ls', '/tmp'], scoopTag);
    await until(
      () => newest(local).detail.command === '/usr/bin/ls /tmp' && newest(local).tier === 'user',
      'the unsure one to reach a person'
    );
    const escalated = newest(local);
    const lick = await until(() => licks().find((text) => text.includes('ls /tmp')), 'the lick');
    await model.approvals.decide(escalated.id, 'deny');
    await unsure;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const quiet = licks().some((text) => text.includes('/usr/bin/ls /etc'));
    await local.close();
    await owner.release();
    return {
      waiting,
      listed,
      calls,
      status: result.status,
      decided,
      judgedRun: judgedRun.status,
      byJudge: { tier: byJudge.tier, decidedBy: byJudge.decidedBy, answer: byJudge.answer },
      after,
      context,
      allowed: allowed.status,
      escalated: escalated.verdict?.decision ?? null,
      lick,
      quiet,
    };
  });
  assert.equal(seen.calls, 1);
  assert.deepEqual(seen.waiting, [
    { state: 'pending', tier: 'user', decidedBy: null, verdict: null },
    { state: 'pending', tier: 'user', decidedBy: null, verdict: null },
  ]);
  assert.equal(seen.listed, true);
  assert.equal(seen.status, 0);
  assert.deepEqual(seen.decided, ['owner', 'owner']);
  assert.equal(seen.judgedRun, 0);
  assert.deepEqual(seen.byJudge, { tier: 'agent', decidedBy: 'judge', answer: 'once' });
  assert.deepEqual(seen.context, { target: 'root', cwd: '/' });
  assert.equal(seen.allowed, 0);
  assert.equal(seen.escalated, 'unsure');
  assert.match(seen.lick, /helper asked to run \/usr\/bin\/ls \/tmp/);
  assert.equal(seen.quiet, false);
  assert.equal(seen.after, 2);
});

test('a sudo the kernel lets expire is recorded as timed out, not withdrawn', async (t) => {
  const page = await chrome.page(t);
  await boot(page);
  const seen = await page.evaluate(async () => {
    const { owner, until, newest } = globalThis.t;
    const local = await owner.connect();
    const expiresAt = Date.now() + 1500;
    const kernel = new AbortController();
    const asked = owner.approve(
      {
        id: 'sudo-9',
        kind: 'sudo',
        user: 'cone',
        target: 'root',
        argv: ['ls', '/root'],
        path: '/usr/bin/ls',
        cwd: '/',
        expiresAt,
        always: true,
      },
      { signal: kernel.signal }
    );
    await until(() => newest(local)?.state === 'pending', 'the request');
    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now() - 300));
    kernel.abort('expired');
    const answer = await asked;
    await until(() => newest(local).state !== 'pending', 'the record to settle');
    const { state, reason } = newest(local);
    await local.close();
    await owner.release();
    return { answer, state, reason };
  });
  assert.deepEqual(seen, { answer: 'deny', state: 'unanswered', reason: 'timeout' });
});

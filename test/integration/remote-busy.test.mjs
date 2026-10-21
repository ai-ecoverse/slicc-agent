import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.clock = (now) => new BroadcastChannel('slicc-test-clock').postMessage({ now });
  window.listening = new Set();
  window.streams = (look) => {
    window.listening.add(look);
    return () => window.listening.delete(look);
  };
  window.setup = async (query, now, users = false) => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    window.kernel = now
      ? await bootKernel(
          {},
          { worker: new URL(`/clock-kernel-worker.js?now=${now}`, location.href) }
        )
      : await bootKernel();
    stage('the agent');
    window.owner = await startAgent({
      worker: () => {
        window.worker = new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' });
        return window.worker;
      },
      kernel: {
        connect: (options) =>
          window.kernel.connect(options?.user ? { user: options.user } : undefined),
        ...(users ? { users: window.kernel.users } : {}),
      },
    });
    window.connection = await window.owner.connect();
    window.remote = remoteControl(window.connection);
    window.sh = (command, options = {}) => window.kernel.run(['bash', '-c', command], options);
    await when(
      [files(window.kernel, ['/usr/local/bin'])],
      async () => (await window.sh('test -x /usr/local/bin/agent')).status === 0,
      'the agent command'
    );
  };
  window.watching = (check, what) =>
    when([window.streams, ...agentSources(window.connection), every(1000)], check, what);
  window.helper = (state) =>
    window.watching(async () => {
      const listed = await window.sh('subagent list');
      return new RegExp(`^helper\t.*\t${state}$`, 'm').test(listed.stdout);
    }, `the helper ${state}`);
  window.follow = async (remote = window.remote, request = { busy: true }) => {
    const watched = await remote.watch(request);
    const seen = [];
    void (async () => {
      for await (const event of watched.events) {
        seen.push(event);
        for (const look of window.listening) look();
      }
    })();
    return { opened: watched, seen };
  };
  window.flips = (seen) => seen.filter((event) => event.t === 'busy').map((event) => event.busy);
  window.settled = (seen) => window.flips(seen).at(-1) === false;
};

function ordered(seen) {
  const at = (find) => seen.findIndex(find);
  const last = (find) => seen.findLastIndex(find);
  const busy = seen.filter((event) => event.t === 'busy');
  const firstStart = at((event) => event.t === 'run' && event.state === 'start');
  const lastEnd = last((event) => event.t === 'run' && event.state === 'end');
  assert.deepEqual(
    busy.map((event) => event.busy),
    [true, false]
  );
  assert.ok(Array.isArray(busy[0].why) && busy[0].why.length > 0, JSON.stringify(busy[0]));
  assert.equal('why' in busy[1], false);
  assert.ok(at((event) => event.t === 'busy' && event.busy) < firstStart, JSON.stringify(seen));
  assert.ok(last((event) => event.t === 'busy' && !event.busy) > lastEnd, JSON.stringify(seen));
  return seen.filter((event) => event.t === 'run' && event.state === 'start').length;
}

const step = (value) => ['step', JSON.stringify(value)];
const spawn = (extra = '') =>
  `SLICC_AGENT=cone:cone subagent spawn --name helper ${extra}--prompt "Work on it"`;

test('a prompt whose run ends while its scoop works stays busy until the notify turn ends, then flips false once', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = new URLSearchParams([
    step({ tool: { name: 'bash', args: { command: spawn() } } }),
    step({ answer: 'Spawned.' }),
    step({ gate: 'notify', answer: 'Noted.' }),
    ['scoop-step', JSON.stringify({ gate: 'scoop', answer: 'Scoop done.' })],
  ]).toString();
  await staged(
    page,
    'the watched prompt',
    async (query) => {
      await window.setup(query);
      stage('the watches');
      const service = window.connection.remote;
      const older = remoteControl({
        remote: {
          prompt: (...args) => service.prompt(...args),
          next: (...args) => service.next(...args),
          close: (...args) => service.close(...args),
          abort: (...args) => service.abort(...args),
          watch: async (...args) => {
            const { busy: _, ...rest } = await service.watch(...args);
            return rest;
          },
        },
      });
      window.plain = await window.follow(window.remote, {});
      window.old = await window.follow(older);
      window.first = await window.follow();
      stage('the prompt');
      const prompted = await window.remote.prompt({ text: 'Start a scoop.' });
      window.prompt = [];
      for await (const event of prompted.events) window.prompt.push(event);
      await window.helper('working');
    },
    query
  );
  await staged(page, 'the scoop run', async () => {
    window.second = await window.follow();
    window.scoop = await window.follow(
      remoteControl(window.connection, { agent: () => 'scoop:helper' })
    );
    window.during = [...window.first.seen];
    window.worker.postMessage({ gate: 'scoop' });
    await window.watching(
      () =>
        window.first.seen.filter((event) => event.t === 'run' && event.state === 'start').length ===
        2,
      'the notify run'
    );
  });
  const notifying = await page.evaluate(async () => {
    await window.pause(500);
    const flips = window.flips(window.scoop.seen);
    window.worker.postMessage({ gate: 'notify' });
    return flips;
  });
  await staged(page, 'the settled watches', () =>
    window.watching(
      () =>
        window.settled(window.first.seen) &&
        window.settled(window.second.seen) &&
        window.settled(window.scoop.seen),
      'every watch idle'
    )
  );
  const seen = await page.evaluate(async () => {
    await window.pause(1000);
    await window.owner.release();
    return {
      opened: [window.first.opened.busy, window.second.opened.busy, window.scoop.opened.busy],
      scoop: window.flips(window.scoop.seen),
      plain: { busy: 'busy' in window.plain.opened, flips: window.flips(window.plain.seen) },
      old: { busy: 'busy' in window.old.opened },
      prompt: window.prompt.at(-1),
      during: window.during,
      first: window.first.seen,
      second: window.second.seen,
    };
  });
  assert.deepEqual(seen.opened, [false, true, true]);
  assert.deepEqual(notifying, []);
  assert.deepEqual(seen.scoop, [false]);
  assert.deepEqual(seen.plain, { busy: false, flips: [] });
  assert.deepEqual(seen.old, { busy: false });
  assert.deepEqual(seen.prompt, { t: 'end', reason: 'stop' });
  assert.ok(
    seen.during.some((event) => event.t === 'run' && event.state === 'end'),
    JSON.stringify(seen.during)
  );
  assert.deepEqual(
    seen.during.filter((event) => event.t === 'busy').map((event) => event.busy),
    [true]
  );
  assert.ok(seen.during.find((event) => event.t === 'busy').why.includes('cone'));
  assert.equal(ordered(seen.first), 2);
  const notice = seen.first.findIndex(
    (event) => event.t === 'notice' && event.text.startsWith('lick scoop-notify: helper')
  );
  assert.ok(notice > seen.first.findIndex((event) => event.t === 'run' && event.state === 'end'));
  assert.deepEqual(
    seen.second.filter((event) => event.t === 'busy').map((event) => event.busy),
    [false]
  );
  assert.ok(
    seen.second.findIndex((event) => event.t === 'busy') >
      seen.second.findLastIndex((event) => event.t === 'run' && event.state === 'end')
  );
});

test('a scoop-notify lick held in the outbox until the cone has a model keeps the agent busy', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const query = new URLSearchParams([
    ['model', 'faux-2'],
    ['answer', 'Scoop done.'],
    ['answer', 'Noted.'],
  ]).toString();
  const seen = await staged(
    page,
    'a held scoop-notify lick',
    async ({ query, command }) => {
      await window.setup(query, undefined, true);
      await when(
        [files(window.kernel, ['/var/lib/slicc/agent/requests'])],
        async () => (await window.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0,
        'the cone control directory'
      );
      const watched = await window.follow();
      stage('the scoop');
      const spawned = await window.sh(command, { user: 'cone' });
      await window.helper('idle');
      stage('the held lick');
      await window.pause(3000);
      const held = [...watched.seen];
      const { agent } = createAgentModel(window.connection, { storage: localStorage });
      await agent.ready();
      agent.setModel(agent.active(), 'faux/faux-2');
      await window.watching(() => window.settled(watched.seen), 'the notify turn');
      await window.owner.release();
      return { opened: watched.opened.busy, spawned: spawned.status, held, seen: watched.seen };
    },
    { query, command: spawn('--model faux/faux-2 ').replace('SLICC_AGENT=cone:cone ', '') }
  );
  assert.equal(seen.opened, false);
  assert.equal(seen.spawned, 0);
  assert.deepEqual(
    seen.held.filter((event) => event.t === 'busy'),
    [{ t: 'busy', busy: true, why: ['scoop:helper'] }]
  );
  assert.equal(
    seen.held.some((event) => event.t === 'run'),
    false
  );
  assert.equal(ordered(seen.seen), 1);
  assert.ok(
    seen.seen.some(
      (event) => event.t === 'notice' && event.text.startsWith('lick scoop-notify: helper')
    )
  );
});

test('a cron lick makes the agent busy only once it is queued, and idle again after its turn', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const seen = await staged(page, 'a cron lick', async () => {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(10, 59, 0, 0);
    const base = start.getTime();
    await window.setup('answer=Noted.', base);
    const watched = await window.follow();
    const table = "# name: standup\n0 * * * * agent send cone --lick=cron 'Check the build'\n";
    const installed = await window.kernel.run(['crontab', '-'], { stdin: table });
    stage('a quiet window');
    await window.pause(1500);
    const armed = [...watched.seen];
    window.clock(base + 61_000);
    await window.watching(() => window.settled(watched.seen), 'the cron turn');
    await window.owner.release();
    return { opened: watched.opened.busy, installed: installed.status, armed, seen: watched.seen };
  });
  assert.equal(seen.opened, false);
  assert.equal(seen.installed, 0);
  assert.deepEqual(seen.armed, []);
  assert.equal(ordered(seen.seen), 1);
  assert.ok(
    seen.seen.some((event) => event.t === 'notice' && event.text.startsWith('lick cron:')),
    JSON.stringify(seen.seen)
  );
});

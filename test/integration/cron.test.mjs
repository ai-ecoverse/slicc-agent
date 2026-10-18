import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const HOUR = 3_600_000;

const helpers = () => {
  window.write = async (path, text) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(text);
    await writable.close();
  };
  window.clock = (now) => new BroadcastChannel('slicc-test-clock').postMessage({ now });
  window.sh = async (command, options = {}) => window.kernel.run(['bash', '-c', command], options);
  window.cronLicks = (id) =>
    window.agent
      .messages(id)
      .filter((message) => message.role === 'lick' && message.channel === 'cron')
      .map(({ title, text, body, count, severity }) => ({ title, text, body, count, severity }));
  window.boot = async () => {
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(10, 59, 0, 0);
    window.base = start.getTime();
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    window.kernel = await bootKernel(
      {},
      { worker: new URL(`/clock-kernel-worker.js?now=${window.base}`, location.href) }
    );
    return window.base;
  };
  window.start = async (users) => {
    const answers = Array.from({ length: 8 }, () => 'answer=Noted.').join('&');
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: {
        connect: (options) =>
          window.kernel.connect(options?.user ? { user: options.user } : undefined),
        ...(users ? { users: window.kernel.users } : {}),
      },
    });
    window.connection = await owner.connect();
    window.agent = createAgentModel(window.connection, { storage: localStorage }).agent;
    await window.agent.ready();
  };
  window.stamped = async (name) =>
    (await window.sh('cat /var/spool/cron/stamp')).stdout.includes(name);
};

test('a ~/.slicc/crontab line moves into the kernel crontab and comes back as one cron lick per due run, missed runs folded, a broken file refused', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const base = await page.evaluate(async () => {
    await window.write('/home/.slicc/crontab', '0 * * * * standup Check the build\n');
    const base = await window.boot();
    const probe = '# name: probe\n0 * * * * env > /tmp/cron-env\n';
    const installed = await window.kernel.run(['crontab', '-'], { stdin: probe });
    if (installed.status !== 0) throw new Error(installed.stderr);
    await window.start(false);
    return base;
  });
  const table = await page.within(60000, async () => {
    const listed = await window.kernel.run(['crontab', '-l']);
    return listed.stdout.includes('standup') && listed.stdout;
  });
  assert.equal(
    table,
    "# name: probe\n0 * * * * env > /tmp/cron-env\n# name: standup\n0 * * * * agent send cone --lick=cron 'Check the build'\n"
  );
  const moved = await page.evaluate(async () => ({
    old: (await window.sh('test -e /home/.slicc/crontab; echo $?')).stdout,
    backup: (await window.sh('cat /home/.slicc/crontab.migrated')).stdout,
  }));
  assert.deepEqual(moved, { old: '1\n', backup: '0 * * * * standup Check the build\n' });
  await page.within(30000, () => window.stamped('standup'));
  await page.evaluate((now) => window.clock(now), base + 61_000);
  await page.within(60000, () => window.cronLicks().length === 1);
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  await page.evaluate((now) => window.clock(now), base + 3 * HOUR + 61_000);
  await page.within(60000, () => window.cronLicks().length === 2);
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  const env = await page.within(30000, async () => {
    const read = await window.sh('cat /tmp/cron-env');
    return read.status === 0 && read.stdout.includes('SLICC_CRON_MISSED=2') && read.stdout;
  });
  assert.match(env, /^SLICC_CRON=1$/m);
  assert.match(env, /^USER=root$/m);
  assert.doesNotMatch(env, /^SLICC_AGENT=/m);
  assert.doesNotMatch(env, /^SLICC_CDP_URL=/m);
  await page.evaluate(() =>
    window.sh('cat > /home/.slicc/crontab', { stdin: '61 * * * * broken\n' })
  );
  await page.within(60000, () => window.cronLicks().length === 3);
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const seen = await page.evaluate(async () => ({
    licks: window.cronLicks(),
    table: (await window.kernel.run(['crontab', '-l'])).stdout,
    kept: (await window.sh('cat /home/.slicc/crontab')).stdout,
  }));
  const [due, missed, refused] = seen.licks;
  assert.equal(seen.licks.length, 3);
  assert.equal(due.title, 'standup');
  assert.match(due.text, /^standup fired at \d{4}-\d\d-\d\d 11:00$/);
  assert.equal(due.body, 'Check the build');
  assert.equal(due.count, undefined);
  assert.equal(missed.title, 'standup');
  assert.match(
    missed.text,
    /^standup was due at \d{4}-\d\d-\d\d 14:00; 2 more fires were missed while seven was closed$/
  );
  assert.equal(missed.count, 3);
  assert.equal(refused.title, 'Invalid ~/.slicc/crontab');
  assert.equal(refused.text, 'line 1: minute: 61 is outside 0-59');
  assert.equal(refused.severity, 'error');
  assert.equal(seen.table, table);
  assert.equal(seen.kept, '61 * * * * broken\n');
});

test("a scoop's line in a cone's ~/.slicc/crontab goes into the scoop user's own crontab and fires into that scoop", async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const base = await page.evaluate(async () => {
    const base = await window.boot();
    await window.start(true);
    return base;
  });
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0
  );
  const spawned = await page.evaluate(() =>
    window.sh('agent --async --name nightly --prompt "Stand by"', { user: 'cone' })
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  const handle = spawned.stdout.trim();
  const user = `scoop-${handle}`;
  await page.within(
    60000,
    async (user) => (await window.kernel.users.list()).some((entry) => entry.name === user),
    user
  );
  await page.within(60000, (id) => !window.agent.busy(id), `scoop:${handle}`);
  const written = await page.evaluate(
    (handle) =>
      window.sh('mkdir -p /home/cone/.slicc && cat > /home/cone/.slicc/crontab', {
        stdin: `0 * * * * nightly scoop:${handle} Nightly pass\n`,
      }),
    handle
  );
  assert.equal(written.status, 0, written.stderr);
  const table = await page.within(
    60000,
    async (user) => {
      const listed = await window.kernel.run(['crontab', '-u', user, '-l']);
      return listed.status === 0 && listed.stdout;
    },
    user
  );
  assert.equal(
    table,
    `# name: nightly\n0 * * * * agent send scoop:${handle} --lick=cron 'Nightly pass'\n`
  );
  const cone = await page.evaluate(
    async () => (await window.kernel.run(['crontab', '-u', 'cone', '-l'])).status
  );
  assert.equal(cone, 1);
  await page.within(30000, () => window.stamped('nightly'));
  await page.evaluate((id) => window.agent.select(id), `scoop:${handle}`);
  await page.evaluate((now) => window.clock(now), base + 61_000);
  const licks = await page.within(
    60000,
    (id) => {
      const found = window.cronLicks(id);
      return found.length === 1 && found;
    },
    `scoop:${handle}`
  );
  assert.equal(licks[0].title, 'nightly');
  assert.equal(licks[0].body, 'Nightly pass');
  assert.match(licks[0].text, /^nightly fired at \d{4}-\d\d-\d\d 11:00$/);
  assert.deepEqual(await page.evaluate(() => window.cronLicks('cone')), []);
});

test('jobs migrated before --lick=cron are rewritten at start and fire as cron licks, while a plain agent send in a job is just a message', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const base = await page.evaluate(async () => {
    await window.write('/home/.slicc/crontab.migrated', '0 * * * * standup Check the build\n');
    const base = await window.boot();
    const old = [
      '# name: standup',
      "0 * * * * agent send cone 'Check the build'",
      '# name: plain',
      "0 * * * * agent send helper 'Just a message'",
      '',
    ].join('\n');
    const installed = await window.kernel.run(['crontab', '-'], { stdin: old });
    if (installed.status !== 0) throw new Error(installed.stderr);
    await window.start(false);
    return base;
  });
  const table = await page.within(60000, async () => {
    const listed = await window.kernel.run(['crontab', '-l']);
    return listed.stdout.includes('--lick=cron') && listed.stdout;
  });
  assert.equal(
    table,
    "# name: standup\n0 * * * * agent send cone --lick=cron 'Check the build'\n# name: plain\n0 * * * * agent send helper 'Just a message'\n"
  );
  const spawned = await page.evaluate(() =>
    window.sh('agent --async --name helper --prompt "Stand by"')
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  await page.within(60000, () => !window.agent.busy('scoop:helper'));
  await page.within(
    30000,
    async () => (await window.stamped('standup')) && window.stamped('plain')
  );
  await page.evaluate((now) => window.clock(now), base + 61_000);
  const scoop = await page.within(60000, () => {
    const found = window.agent
      .messages('scoop:helper')
      .filter((message) => message.role === 'user' && message.text === 'Just a message');
    return found.length === 1 && found;
  });
  assert.equal(scoop.length, 1);
  const licks = await page.within(60000, () => {
    const found = window.cronLicks();
    return found.length === 1 && found;
  });
  assert.equal(licks[0].title, 'standup');
  assert.equal(licks[0].body, 'Check the build');
  await page.within(60000, () => !window.agent.busy(window.agent.active()));
  assert.deepEqual(await page.evaluate(() => window.cronLicks('scoop:helper')), []);
});

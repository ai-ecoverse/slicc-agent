import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a terminal runs agent through the production worker: a sync call, an async scoop and a wait', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'a terminal runs agent through', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const answers = ['From the sync scoop.', 'From the async scoop.']
      .map((answer) => `answer=${encodeURIComponent(answer)}`)
      .join('&');
    const owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${answers}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    const run = async (command) => {
      const decoder = new TextDecoder();
      let out = '';
      const process = await terminal.spawn(['bash', '-c', command], {
        cwd: '/home',
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
        },
        onStderr: (bytes) => {
          out += decoder.decode(bytes);
        },
      });
      return { code: await process.exited, out };
    };
    await when(
      [files(kernel, ['/usr/local/bin'])],
      () => terminal.fs.exists('/usr/local/bin/agent'),
      'the agent command'
    );
    const sync = await run('agent --name probe --prompt "Say hello"');
    const archived = await terminal.fs.readFile('/tmp/agent-sessions/probe.md');
    const spawned = await run('subagent spawn --name helper --prompt "Work on it"');
    const waited = await run('agent wait helper --timeout 20');
    const listed = await run('agent list');
    const skills = await run('ls /var/lib/slicc/agent/skills /var/lib/slicc/agent/prompts');
    const commands = connection.commands.value.map((command) => `${command.kind}:${command.name}`);
    await owner.release();
    return {
      sync,
      archived: typeof archived === 'string' ? archived : new TextDecoder().decode(archived),
      spawned,
      waited,
      listed,
      skills,
      commands,
    };
  });
  assert.deepEqual(seen.sync, { code: 0, out: 'From the sync scoop.\n' });
  assert.match(
    seen.archived,
    /^# probe\n\n## Request\n\nSay hello\n\n## Answer\n\nFrom the sync scoop\.\n$/
  );
  assert.deepEqual(seen.spawned, { code: 0, out: 'helper\n' });
  assert.equal(seen.waited.code, 0);
  assert.match(seen.waited.out, /From the async scoop\./);
  assert.match(seen.listed.out, /^helper\t/m);
  assert.match(seen.skills.out, /agent\n/);
  assert.match(seen.skills.out, /review-loop\.md/);
  assert.ok(seen.commands.includes('prompt:parallel-review'));
  assert.ok(seen.commands.includes('skill:skill:licks'));
});

test('a pnpm-linked package in /opt/user/node_modules adds its skills, and one that duplicates a system package is ignored', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'a pnpm-linked package in optusernode_modules', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    const write = async (path, text) => {
      await terminal.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await terminal.fs.writeFile(path, text);
    };
    const skill = (name) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`;
    const manifest = JSON.stringify({ pi: { skills: ['./skills'] } });
    await write('/node_modules/syspack/package.json', manifest);
    await write('/node_modules/syspack/skills/sys-skill/SKILL.md', skill('sys-skill'));
    await write('/opt/user/node_modules/syspack/package.json', manifest);
    await write('/opt/user/node_modules/syspack/skills/twin-skill/SKILL.md', skill('twin-skill'));
    const store = '/opt/user/node_modules/.pnpm/userpack@1.0.0/node_modules/userpack';
    await write(`${store}/package.json`, manifest);
    await write(`${store}/skills/user-skill/SKILL.md`, skill('user-skill'));
    await terminal.fs.symlink(store, '/opt/user/node_modules/userpack');
    const owner = await startTracked({
      worker: () => new Worker('/dist-test/main-worker.js', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const commands = await when(
      [connection.commands],
      () => {
        const names = connection.commands.value.map((command) => command.name);
        return names.includes('skill:user-skill') && names;
      },
      'the user skill'
    );
    await owner.release();
    return commands;
  });
  assert.ok(seen.includes('skill:user-skill'));
  assert.ok(seen.includes('skill:sys-skill'));
  assert.ok(!seen.includes('skill:twin-skill'));
});

test("a skill bios links from /usr/share/skills into root's global pnpm reads as its package, a plain one as global, and an unlinked one there isn't loaded", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'a skill bios links from', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    const write = async (path, text) => {
      await terminal.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await terminal.fs.writeFile(path, text);
    };
    const skill = (name) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\nBody.\n`;
    const pkg = '/usr/local/share/pnpm/5/.pnpm/foo-pkg@1.2.0/node_modules/foo-pkg';
    await write(
      `${pkg}/package.json`,
      JSON.stringify({ name: 'foo-pkg', version: '1.2.0', pi: { skills: ['dist/skills'] } })
    );
    await write(`${pkg}/dist/skills/foo/SKILL.md`, skill('foo'));
    await write(`${pkg}/dist/skills/unlinked/SKILL.md`, skill('unlinked'));
    await write('/usr/share/skills/plain/SKILL.md', skill('plain'));
    await terminal.fs.symlink(`${pkg}/dist/skills/foo`, '/usr/share/skills/foo');
    const owner = await startTracked({
      worker: () => new Worker('/dist-test/main-worker.js', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const commands = await when(
      [connection.commands],
      () => {
        const listed = connection.commands.value;
        return listed.some((command) => command.name === 'skill:foo') && listed;
      },
      'the package skill'
    );
    await owner.release();
    return commands.filter((command) => command.kind === 'skill');
  });
  const by = Object.fromEntries(seen.map((command) => [command.name, command]));
  assert.equal(by['skill:foo'].source, 'package');
  assert.deepEqual(by['skill:foo'].package, { name: 'foo-pkg', version: '1.2.0' });
  assert.equal(by['skill:plain'].source, 'global');
  assert.equal(by['skill:plain'].package, undefined);
  assert.equal(by['skill:unlinked'], undefined);
});

test('with per-user kernel clients, a scoop report is written as the cone, so the cone keeps its ~/.slicc and can add its own files there', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await staged(page, 'with per-user kernel clients a', async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    window.owner = await startTracked({
      worker: () => new Worker('/dist-test/main-worker.js?answer=Reported.', { type: 'module' }),
      kernel: {
        connect: (options) => kernel.connect(options?.user ? { user: options.user } : undefined),
        users: kernel.users,
      },
    });
    await createAgentModel(await window.owner.connect(), { storage: localStorage }).agent.ready();
    window.sh = (command, user) => kernel.run(['bash', '-c', command], user ? { user } : {});
  });
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/cone/in')).status === 0
  );
  const spawned = await page.evaluate(() =>
    window.sh('agent --async --name helper --prompt "Report back"', 'cone')
  );
  assert.equal(spawned.status, 0, spawned.stderr);
  const handle = spawned.stdout.trim();
  const reports = await page.within(
    60000,
    async (handle) => (await window.sh(`ls /home/cone/.slicc/reports/${handle}`)).stdout.trim(),
    handle
  );
  assert.match(reports, /\.md$/);
  const seen = await staged(
    page,
    'with per-user kernel clients a',
    async (handle) => {
      const owners = (
        await window.sh(
          `cd /home/cone/.slicc && stat -c "%U %n" . reports reports/${handle} reports/${handle}/*.md`
        )
      ).stdout;
      const own = await window.sh(
        'mkdir -p ~/.slicc/watches && echo "{}" > ~/.slicc/watches/mine.json && echo ok',
        'cone'
      );
      await window.owner.release();
      return { owners, own };
    },
    handle
  );
  assert.equal(
    seen.owners,
    `cone .\ncone reports\ncone reports/${handle}\ncone reports/${handle}/${reports}\n`
  );
  assert.deepEqual([seen.own.status, seen.own.stdout], [0, 'ok\n'], seen.own.stderr);
});

test("a scoop's notify card reads as its one-line result, or says it failed, and keeps the raw line and report for the agent", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const spawn = (name, prompt) => ({
    tool: { name: 'bash', args: { command: `subagent spawn --name ${name} --prompt "${prompt}"` } },
  });
  const steps = [
    ...[
      spawn('auditor', 'Audit it'),
      { answer: 'Spawned.' },
      { answer: 'Noted.' },
      spawn('breaker', 'Break it'),
      { answer: 'Spawned again.' },
      { answer: 'Noted again.' },
      { answer: 'Spare.' },
    ].map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`),
    ...[
      { gate: 'audit', answer: 'Found **two** bugs in `secret list`.\n\nDetails follow.' },
      { gate: 'break', error: 'boom' },
    ].map((step) => `scoop-step=${encodeURIComponent(JSON.stringify(step))}`),
  ].join('&');
  await staged(
    page,
    'a scoop’s notify card reads',
    async (steps) => {
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      window.owner = await startTracked({
        worker: () => {
          window.worker = new Worker(`/dist-test/main-worker.js?${steps}`, { type: 'module' });
          return window.worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      window.connection = await window.owner.connect();
      window.agent = createAgentModel(window.connection, { storage: localStorage }).agent;
      await window.agent.ready();
      window.sh = (command) => kernel.run(['bash', '-c', command]);
      window.cards = () =>
        window.agent
          .messages()
          .filter((message) => message.role === 'lick' && message.channel === 'scoop-notify')
          .map(({ title, text, body, summary, report, severity }) => ({
            title,
            text,
            body,
            summary,
            report,
            severity,
          }));
    },
    steps
  );
  await page.within(
    60000,
    async () => (await window.sh('test -x /usr/local/bin/agent')).status === 0
  );
  await page.evaluate(async () => {
    await window.connection.prompt('Spawn an auditor.');
    window.worker.postMessage({ gate: 'audit' });
  });
  const [done] = await page.within(60000, () =>
    window.cards().length === 1 && !window.agent.busy(window.agent.active())
      ? window.cards()
      : undefined
  );
  assert.equal(done.title, 'auditor (scoop)');
  assert.equal(done.summary, 'Found two bugs in secret list.');
  assert.match(done.report, /\/reports\/.+\.md$/);
  assert.equal(done.text, '[scoop auditor (scoop) completed]');
  assert.ok(done.body.startsWith(`Output: ${done.report} (3 lines)`), done.body);
  assert.match(done.body, /Found \*\*two\*\* bugs in `secret list`\./);
  await page.evaluate(async () => {
    await window.connection.prompt('Spawn a breaker.');
    window.worker.postMessage({ gate: 'break' });
  });
  const cards = await page.within(60000, () =>
    window.cards().length === 2 ? window.cards() : undefined
  );
  const failed = cards.find((card) => card.title === 'breaker (scoop)');
  assert.equal(failed.summary, 'Scoop breaker failed');
  assert.equal(failed.report, undefined);
  assert.equal(failed.text, '[scoop breaker (scoop) failed]');
  assert.equal(failed.severity, 'warn');
  assert.match(failed.body, /^Reason: /);
  await page.evaluate(() => window.owner.release());
});

test('a request queued behind a busy scoop shows who sent it once it is placed, and agent wait --notify sends one lick when the scoop is done', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const command =
    'subagent spawn --name helper --prompt First. && agent send helper --follow-up Second. && agent wait helper --notify';
  const steps = [
    ...[
      { tool: { name: 'bash', args: { command } } },
      { answer: 'Waiting.' },
      { answer: 'Noted.' },
      { answer: 'Spare.' },
      { answer: 'Spare.' },
      { answer: 'Spare.' },
    ].map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`),
    ...[{ gate: 'first', answer: 'First done.' }, { answer: 'Second done.' }].map(
      (step) => `scoop-step=${encodeURIComponent(JSON.stringify(step))}`
    ),
  ].join('&');
  const seen = await staged(
    page,
    'a queued request and a notify wait',
    async (steps) => {
      const { bootKernel } = await import('/kernel.js');
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      let worker;
      const owner = await startTracked({
        worker: () => {
          worker = new Worker(`/dist-test/main-worker.js?${steps}`, { type: 'module' });
          return worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      const agent = model.agent;
      await agent.ready();
      await when(
        [files(kernel, ['/usr/local/bin'])],
        async () => (await kernel.run(['test', '-x', '/usr/local/bin/agent'])).status === 0,
        'the agent command'
      );
      stage('the busy scoop');
      const started = await connection.prompt('Start a helper and wait for it.');
      worker.postMessage({ gate: 'first' });
      stage('the wait lick');
      const sources = agentSources(connection, model);
      const licks = () =>
        agent
          .messages()
          .filter((message) => message.role === 'lick' && message.channel === 'scoop-wait');
      const [lick] = await when(sources, () => licks().length && licks(), 'the scoop-wait lick');
      stage('the placed request');
      const scoop = agent.list().find((row) => row.name === 'helper');
      agent.select(scoop.id);
      const second = await when(
        sources,
        () =>
          agent
            .messages()
            .find(
              (message) => message.role === 'user' && message.text === 'Second.' && message.from
            ),
        'the placed request with its sender'
      );
      agent.select('cone');
      const waits = licks().length;
      await owner.release();
      return {
        started,
        lick: { title: lick.title, text: lick.text, body: lick.body },
        from: second.from,
        waits,
      };
    },
    steps
  );
  assert.equal(seen.started, 'Waiting.');
  assert.equal(seen.lick.title, 'Waited for helper');
  assert.equal(seen.lick.text, 'All 1 done');
  assert.match(seen.lick.body, /## helper\n/);
  assert.equal(seen.from, 'sliccy');
  assert.equal(seen.waits, 1);
});

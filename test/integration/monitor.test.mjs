import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the live monitor through the production worker: it runs only while the panel listens, shows the agent background process, and a view-only connection sees program names only', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the live monitor', async () => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    stage('the agent');
    const params = new URLSearchParams([
      [
        'tool',
        JSON.stringify({
          name: 'bash',
          args: {
            command:
              "bash -c 'sleep 30; true' x --token=sekrit123 >/dev/null 2>&1 & bash -c 'while :; do :; done' spin >/dev/null 2>&1 & echo started",
          },
        }),
      ],
      ['answer', 'Started.'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const viewer = await owner.connect({ readOnly: true });
    stage('the answer');
    await connection.prompt('Start a sleeper.');
    const idle = connection.monitor.value;
    const model = createAgentModel(connection);
    const wait = (check, what, sources = [heard(model.monitor, 'snapshot')]) =>
      when([connection.monitor, viewer.monitor, ...sources], check, what);
    const snapshots = [];
    const off = model.monitor.on('snapshot', (snapshot) => snapshots.push(snapshot));
    const shown = await wait(() => {
      const snapshot = model.monitor.snapshot();
      const processes = snapshot.sections.find((section) => section.id === 'processes');
      return processes?.rows.some((row) => row.name.includes('--token=[redacted]')) && snapshot;
    }, 'the sleeper in the snapshot');
    const full = connection.monitor.value;
    const timed = full.processes.some((row) => typeof row.utime === 'number');
    const measured = timed
      ? await wait(() => {
          const feed = connection.monitor.value;
          const spin = feed.processes?.find((row) => row.command.includes('while :'));
          return spin && typeof spin.cpu === 'number' && spin.cpu > 0 && feed;
        }, 'the spinner cpu')
      : null;
    const trended = await wait(() => {
      const vitals = model.monitor.snapshot().vitals;
      return vitals.find((vital) => vital.id === 'processes')?.series && vitals;
    }, 'the process trend');
    const viewed = await wait(
      () => viewer.monitor.value?.processes?.length && viewer.monitor.value,
      'the viewer feed'
    );
    off();
    const closed = await wait(
      () => connection.monitor.value.open === false && connection.monitor.value,
      'the closed monitor',
      []
    );
    await owner.release();
    return {
      idle,
      vitals: shown?.vitals.map((vital) => vital.id),
      rows: shown?.sections.find((section) => section.id === 'processes').rows,
      sections: shown?.sections.map((section) => section.id),
      trended: trended?.map((vital) => [vital.id, vital.series?.length ?? 0]),
      agentName: full.agents[0].name,
      full: full.processes.map((row) => row.command),
      viewed: viewed?.processes.map((row) => row.command),
      usage: full.usage,
      snapshots: snapshots.length,
      closed: Boolean(closed),
      timed,
      keys: [...new Set(full.processes.flatMap((row) => Object.keys(row)))],
      spin: measured?.processes.find((row) => row.command.includes('while :')),
      cone: measured?.agents[0],
    };
  });
  assert.equal(seen.idle.open, false);
  assert.equal(seen.idle.processes, null);
  assert.ok(seen.vitals.includes('agents'));
  assert.ok(seen.vitals.includes('processes'));
  const sleeper = seen.rows.find((row) => row.name.includes('--token=[redacted]'));
  assert.ok(sleeper);
  assert.ok(!sleeper.name.includes('sekrit123'));
  assert.ok(sleeper.badges?.includes('sliccy'));
  assert.equal(seen.agentName, 'sliccy');
  assert.ok(!seen.sections.includes('agents'));
  assert.ok(!seen.sections.includes('sprinkles'));
  const trended = Object.fromEntries(seen.trended);
  assert.ok(trended.processes > 1);
  if (trended.memory !== undefined) assert.ok(trended.memory > 1);
  assert.ok(
    seen.full.some(
      (command) =>
        command.includes("sleep 30; true' x --token=[redacted]") ||
        command.includes('sleep 30; true x --token=[redacted]')
    )
  );
  assert.ok(!seen.full.some((command) => command.includes('sekrit123')));
  assert.ok(!seen.full.some((command) => command.includes('SLICC_AGENT')));
  assert.ok(seen.viewed.includes('bash'));
  assert.ok(seen.viewed.every((command) => !command.includes(' ')));
  assert.ok(seen.usage);
  assert.ok(seen.snapshots > 0);
  assert.ok(seen.closed);
  assert.equal(seen.timed, true);
  assert.ok(seen.keys.includes('utime') && seen.keys.includes('stime'));
  assert.equal(typeof seen.spin.utime, 'number');
  assert.ok(seen.spin.cpu > 0);
  assert.equal(seen.spin.agentId, 'cone');
  assert.ok(seen.cone.cpu >= seen.spin.cpu);
});

test('the budget card says when the weekly budget resets in calendar days, with the exact time as its tooltip', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const day = 86400000;
  const resets = new Date((Math.floor(Date.now() / day) + 2) * day + 60000).toISOString();
  const record = {
    kind: 'model',
    name: 'ADOBE_IMS_TOKEN',
    provider: 'adobe',
    placeholder: 'fnox_proxy_adobe',
    value: 'budget-key-0001',
  };
  const query = [
    'relay=mcp.test',
    'e2e',
    'vault',
    `resets=${encodeURIComponent(resets)}`,
    `record=${encodeURIComponent(JSON.stringify(record))}`,
  ].join('&');
  const vital = await staged(
    page,
    'the budget card',
    async (query) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection);
      await model.agent.ready();
      const card = () => model.monitor.snapshot().vitals.find((entry) => entry.id === 'budget');
      const found = await when(
        [...agentSources(connection, model), connection.monitor],
        card,
        'the budget card'
      );
      await owner.release();
      return found;
    },
    query
  );
  assert.equal(vital?.value, '40%');
  assert.equal(vital.unit, 'resets in 2 days');
  assert.equal(vital.hint, `resets ${resets.slice(0, 16).replace('T', ' ')} UTC`);
});

test('a generation waiting out a retry backoff shows in the monitor as a sleeping task', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = new URLSearchParams([
    ['step', JSON.stringify({ error: 'overloaded_error: Overloaded' })],
    ['answer', 'Recovered.'],
  ]).toString();
  const seen = await staged(
    page,
    'the sleeping retry',
    async (query) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection);
      const off = model.monitor.on('snapshot', () => {});
      const answered = connection.prompt('Try.');
      const sleeping = await when(
        [connection.monitor, heard(model.monitor, 'snapshot')],
        () => {
          const task = connection.monitor.value?.tasks?.find(
            (row) => row.kind === 'pi.generation' && row.status === 'sleeping'
          );
          const watcher = connection.monitor.value?.tasks?.find(
            (row) => row.kind === 'slicc.memory-idle'
          );
          const rows =
            model.monitor.snapshot().sections.find((section) => section.id === 'tasks')?.rows ?? [];
          const row = rows.find((entry) => entry.id === task?.id);
          const idle = rows.find((entry) => entry.id === watcher?.id);
          return task && row && idle && { task, row, idle };
        },
        'the sleeping generation'
      );
      const answer = await answered;
      off();
      await owner.release();
      return { ...sleeping, answer };
    },
    query
  );
  assert.equal(seen.task.status, 'sleeping');
  assert.equal(typeof seen.task.until, 'number');
  assert.equal(seen.task.blocked, null);
  assert.ok(seen.row.badges?.some((badge) => /^sleeps \d+s$/.test(badge)));
  assert.equal(seen.row.status, 'idle');
  assert.equal(seen.idle.name, 'memory idle watch');
  assert.ok(seen.idle.badges?.some((badge) => /^sleeps \d+m$/.test(badge)));
  assert.equal(seen.answer, 'Recovered.');
});

test('a failure pi durable reports without failing the turn shows in the monitor, also when it happened before the panel opened', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the reported failure', async () => {
    await import('/dist-test/page.js');
    stage('the agent');
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/agent-worker.js?failing-section=notes are unreadable&answer=Fine.', {
          type: 'module',
        }),
    });
    const connection = await owner.connect();
    stage('the answer');
    const answer = await connection.prompt('Hello.');
    const before = connection.monitor.value?.open ?? false;
    const model = createAgentModel(connection);
    const off = model.monitor.on('snapshot', () => {});
    stage('the problem');
    const shown = await when(
      [connection.monitor, heard(model.monitor, 'snapshot')],
      () => {
        const problem = connection.monitor.value?.problems?.find(
          (entry) => entry.kind === 'report'
        );
        const row = model.monitor
          .snapshot()
          .sections.find((section) => section.id === 'problems')
          ?.rows.find((entry) => entry.id === problem?.id);
        return problem && row && { problem, row };
      },
      'the reported problem'
    );
    off();
    await owner.release();
    return { answer, before, ...shown };
  });
  assert.equal(seen.answer, 'Fine.');
  assert.equal(seen.before, false);
  assert.equal(seen.problem.agentId, 'cone');
  assert.equal(seen.problem.message, 'notes are unreadable');
  assert.deepEqual(seen.problem.report, { type: 'extension_error', source: 'broken-notes' });
  assert.equal(seen.row.name, 'sliccy · extension error (broken-notes)');
  assert.equal(seen.row.meta, 'notes are unreadable');
  assert.equal(seen.row.status, 'warn');
});

test('a turn cut off by five restarts in a row is parked, the monitor says how to run it again, and agent retry does', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the parked turn', async () => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    const query = new URLSearchParams([
      ['persist', '/.slicc/test-parked'],
      ['step', JSON.stringify({ hold: true })],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const watched = async () => {
      const connection = await owner.connect();
      const model = createAgentModel(connection);
      const off = model.monitor.on('snapshot', () => {});
      const sources = [connection.monitor, heard(model.monitor, 'snapshot')];
      return { connection, model, off, sources };
    };
    stage('the held turn');
    let current = await watched();
    void current.connection.prompt('Work on it.').catch(() => undefined);
    const running = () =>
      current.connection.monitor.value?.tasks?.find(
        (task) => task.kind === 'pi.generation' && task.status === 'running'
      );
    await when(current.sources, running, 'the running generation');
    const parkedNow = () => {
      const task = current.connection.monitor.value?.tasks?.find(
        (row) => row.blocked === 'restart_limit'
      );
      const alert = current.model.monitor
        .snapshot()
        .alerts.find((entry) => entry.id === `parked-${task?.id}`);
      return task && alert && { task, alert };
    };
    let parked;
    let restarts = 0;
    while (!parked && restarts < 8) {
      restarts += 1;
      stage(`restart ${restarts}`);
      current.off();
      await owner.restart();
      current = await watched();
      parked = await when(current.sources, () => running() || parkedNow(), `restart ${restarts}`);
      if (parked.alert) break;
      parked = undefined;
    }
    stage('agent retry');
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
    const retried = await run(parked.alert.command);
    const again = await run(parked.alert.command);
    const resumed = await when(
      current.sources,
      () => {
        const task = current.connection.monitor.value?.tasks?.find(
          (row) => row.id === parked.task.id
        );
        return task && task.blocked === null && task.status === 'running' && task;
      },
      'the generation running again'
    );
    current.off();
    await owner.release();
    return { parked, restarts, retried, again, resumed };
  });
  assert.ok(seen.restarts >= 5 && seen.restarts <= 6, `parked after ${seen.restarts} restarts`);
  assert.equal(seen.parked.task.kind, 'pi.generation');
  assert.equal(seen.parked.alert.command, `agent retry ${seen.parked.task.id}`);
  assert.equal(seen.parked.alert.commandLabel, 'To run it again, run');
  assert.equal(seen.parked.alert.severity, 'error');
  assert.deepEqual(seen.retried, { code: 0, out: `task ${seen.parked.task.id} runs again\n` });
  assert.equal(seen.again.code, 1);
  assert.match(seen.again.out, /isn't parked/);
  assert.equal(seen.resumed.status, 'running');
});

test('the monitor shows the model latency and first-chunk time of the agent’s requests, and nothing they said', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(page, 'the model latency', async () => {
    await import('/dist-test/page.js');
    stage('the kernel');
    const { bootKernel } = await import('/kernel.js');
    const kernel = await bootKernel();
    stage('the agent');
    const owner = await startAgent({
      worker: () =>
        new Worker('/dist-test/main-worker.js?answer=Purple%20elephants.&answer=Again.', {
          type: 'module',
        }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    await connection.prompt('Tell me a secret word.');
    await connection.prompt('Once more.');
    const model = createAgentModel(connection);
    const off = model.monitor.on('snapshot', () => {});
    const vital = await when(
      [connection.monitor, heard(model.monitor, 'snapshot')],
      () => {
        const found = model.monitor.snapshot().vitals.find((entry) => entry.id === 'latency');
        return found && connection.monitor.value?.latency?.requests >= 2 && found;
      },
      'the latency vital'
    );
    const latency = connection.monitor.value.latency;
    off();
    await owner.release();
    return { vital, latency };
  });
  assert.equal(seen.vital.label, 'Model latency');
  assert.match(seen.vital.value, /^\d+ ms$|^\d+\.\d s$/);
  assert.match(seen.vital.unit, /^first chunk (\d+ ms|\d+\.\d s)$/);
  assert.match(seen.vital.hint, /^faux\/faux-1: /);
  assert.equal(seen.latency.errors, 0);
  assert.deepEqual(
    seen.latency.models.map((entry) => entry.model),
    ['faux/faux-1']
  );
  const shown = JSON.stringify(seen);
  assert.ok(!shown.includes('Purple') && !shown.includes('secret word'));
});

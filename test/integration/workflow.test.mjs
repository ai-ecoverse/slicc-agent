import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.boot = async (query) => {
    await import('/dist-test/page.js');
    const { bootKernel } = await import('/kernel.js');
    window.kernel = await bootKernel();
    const owner = await startTracked({
      worker: () => {
        window.worker = new Worker(`/dist-test/main-worker.js?scoop-say&${query}`, {
          type: 'module',
        });
        return window.worker;
      },
      kernel: { connect: () => window.kernel.connect() },
    });
    window.owner = owner;
    window.connection = await owner.connect();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    window.terminal = await attachKernel(await window.kernel.connect());
    await when(
      [files(window.kernel, ['/usr/local/bin'])],
      () => window.terminal.fs.exists('/usr/local/bin/agent'),
      'the agent command'
    );
  };
  window.sh = async (command) => {
    const decoder = new TextDecoder();
    let out = '';
    const process = await window.terminal.spawn(['bash', '-c', command], {
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
  window.put = async (path, text) => {
    await window.terminal.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await window.terminal.fs.writeFile(path, text);
  };
  window.stats = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => resolve(data);
      window.worker.postMessage({ sayStats: channel.port2 }, [channel.port2]);
    });
  window.requests = () =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data }) => resolve(data);
      window.worker.postMessage({ requests: channel.port2 }, [channel.port2]);
    });
  window.release = (name) => window.worker.postMessage({ gate: name });
  window.held = (count) =>
    when([every(100)], async () => (await window.stats()).active >= count, `${count} held scoops`);
  window.status = (id, wanted) =>
    when(
      [every(200)],
      async () => {
        const seen = await window.sh(`agent workflow status ${id}`);
        return seen.out.includes(`(${wanted})`) && seen.out;
      },
      `run ${id} ${wanted}`
    );
};

const workflow = (body, name = 'probe') =>
  [`export const meta = { name: '${name}', description: 'An integration probe.' };`, body].join(
    '\n'
  );

test('agent workflow run --wait fans out scoops with parallel and pipeline, and returns the JSON result', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const source = workflow(
    [
      "phase('Fan out');",
      "const both = await parallel([() => agent('say one', { label: 'first' }), () => agent('say two')]);",
      "const piped = await pipeline(['a', 'b'], (x) => agent('say ' + x), (y) => y.toUpperCase());",
      "const typed = await agent('say {\"n\": 3}', { schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } });",
      "log('done with ' + args.who);",
      'return { both, piped, typed, spent: budget.spent() > 0 };',
    ].join('\n')
  );
  const seen = await staged(
    page,
    'agent workflow run --wait fans out',
    async (source) => {
      await window.boot('');
      await window.put('/home/fan.workflow.js', source);
      const ran = await window.sh(
        `agent workflow run fan.workflow.js --args '{"who":"me"}' --wait`
      );
      const listed = await window.sh('agent workflow list');
      const id = listed.out.split('\t')[0];
      const status = await window.sh(`agent workflow status ${id}`);
      const scoops = await window.sh('agent list');
      return { ran, listed, status, scoops, prompts: (await window.stats()).prompts };
    },
    source
  );
  assert.equal(seen.ran.code, 0, seen.ran.out);
  assert.deepEqual(JSON.parse(seen.ran.out), {
    both: ['one', 'two'],
    piped: ['A', 'B'],
    typed: { n: 3 },
    spent: true,
  });
  assert.match(seen.listed.out, /^\d+\tcompleted\t5\/5\tprobe\n$/);
  assert.match(seen.status.out, /phase: Fan out/);
  assert.match(seen.status.out, /done with me/);
  assert.match(seen.status.out, /agents: 5 done, 0 failed, 0 running, 5 started/);
  assert.equal(seen.scoops.out, 'no scoops\n');
  assert.equal(seen.prompts.length, 5);
});

test('a direct agent() failure rejects, parallel and pipeline turn failures into null, and an unhandled one fails the run', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const handled = workflow(
    [
      "const schema = { type: 'object' };",
      "const direct = await agent('say not json', { schema }).then(() => 'resolved', (e) => 'rejected: ' + e.message);",
      "const bad = await agent('say x', { model: 'haiku' }).then(() => 'resolved', (e) => 'rejected: ' + e.message);",
      "const fanned = await parallel([() => agent('say nope', { schema }), () => agent('say ok')]);",
      "const piped = await pipeline(['a', 'b'], (x) => (x === 'a' ? null : agent('say ' + x)), () => 'second');",
      'let clock = null;',
      'try { Date.now(); } catch (e) { clock = e.message; }',
      'let nested = null;',
      "try { workflow('other'); } catch (e) { nested = e.message; }",
      "const isolated = await agent('say y', { isolation: 'worktree' }).then(() => 'resolved', (e) => e.message);",
      'return { direct, bad, fanned, piped, clock, nested, isolated };',
    ].join('\n')
  );
  const unhandled = workflow(
    "await agent('say \"text\"', { schema: { type: 'number' } });\nreturn 1;"
  );
  const seen = await staged(
    page,
    'a direct agent failure rejects',
    async (handled, unhandled) => {
      await window.boot('');
      await window.put('/home/handled.workflow.js', handled);
      await window.put('/home/unhandled.workflow.js', unhandled);
      const first = await window.sh('agent workflow run handled.workflow.js --wait');
      const second = await window.sh('agent workflow run unhandled.workflow.js --wait');
      const listed = await window.sh('agent workflow list');
      return { first, second, listed };
    },
    handled,
    unhandled
  );
  assert.equal(seen.first.code, 0, seen.first.out);
  const result = JSON.parse(seen.first.out);
  assert.match(result.direct, /^rejected: agent\(\): the answer is not JSON: not json$/);
  assert.equal(result.bad, 'rejected: agent(): model must be provider/model, not haiku');
  assert.deepEqual(result.fanned, [null, 'ok']);
  assert.deepEqual(result.piped, [null, 'second']);
  assert.match(result.clock, /Date\.now\(\) is not allowed in a workflow/);
  assert.equal(result.nested, 'workflow(): nested workflows are not supported in SLICC');
  assert.equal(result.isolated, 'agent(): isolation is not supported in SLICC');
  assert.equal(seen.second.code, 1);
  assert.match(seen.second.out, /failed: agent\(\): the answer does not match the schema/);
  assert.match(seen.listed.out, /\tcompleted\t/);
  assert.match(seen.listed.out, /\tfailed\t/);
});

test('--concurrency caps the scoops running at once, and --budget stops new agents once the output tokens are spent', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const wide = workflow(
    "return parallel([1, 2, 3, 4, 5].map((n) => () => agent('hold wide answer ' + n)));"
  );
  const spend = workflow(
    [
      "const first = await agent('say twenty characters');",
      "const second = await agent('say never').then(() => 'resolved', (e) => e.message);",
      'return { first, second, spent: budget.spent(), remaining: budget.remaining(), total: budget.total };',
    ].join('\n')
  );
  const seen = await staged(
    page,
    '--concurrency caps the scoops',
    async (wide, spend) => {
      await window.boot('');
      await window.put('/home/wide.workflow.js', wide);
      await window.put('/home/spend.workflow.js', spend);
      const started = await window.sh('agent workflow run wide.workflow.js --concurrency 2');
      const id = started.out.split('\n')[0];
      await window.held(2);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const during = await window.stats();
      window.release('wide');
      const waited = await window.sh(`agent workflow wait ${id}`);
      const most = (await window.stats()).most;
      const budgeted = await window.sh('agent workflow run spend.workflow.js --budget 5 --wait');
      const prompts = (await window.stats()).prompts;
      return { during: during.active, most, waited, budgeted, prompts };
    },
    wide,
    spend
  );
  assert.equal(seen.during, 2);
  assert.equal(seen.most, 2);
  assert.equal(seen.waited.code, 0, seen.waited.out);
  assert.deepEqual(JSON.parse(seen.waited.out), [
    'answer 1',
    'answer 2',
    'answer 3',
    'answer 4',
    'answer 5',
  ]);
  assert.equal(seen.budgeted.code, 0, seen.budgeted.out);
  assert.deepEqual(JSON.parse(seen.budgeted.out), {
    first: 'twenty characters',
    second: 'agent(): the budget of 5 output tokens is spent',
    spent: 5,
    remaining: 0,
    total: 5,
  });
  assert.ok(!seen.prompts.includes('say never'));
});

test('a script cannot reach the prelude or lift its caps: a burst of direct host calls still runs two at a time, and a budget lets running agents finish but stops new ones', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const bypass = workflow(
    [
      "const reach = [typeof __WF, typeof __started, typeof __agent, typeof __notify, typeof config, typeof host].join(',');",
      'try { __WF.concurrency = 100; __WF.budget = null; } catch (e) {}',
      "const direct = await Promise.all([1, 2, 3, 4, 5].map((n) => globalThis.__agent({ prompt: 'hold burst direct ' + n }).then((r) => r.value, (e) => e.message)));",
      'return { reach, direct };',
    ].join('\n')
  );
  const burst = workflow(
    [
      "const first = await parallel([1, 2, 3].map(() => () => agent('say twenty characters')));",
      "const after = await agent('say never').then(() => 'resolved', (e) => e.message);",
      'return { first, after, spent: budget.spent() };',
    ].join('\n')
  );
  const seen = await staged(
    page,
    'a script cannot reach the prelude',
    async (bypass, burst) => {
      await window.boot('');
      await window.put('/home/bypass.workflow.js', bypass);
      await window.put('/home/burst.workflow.js', burst);
      const started = await window.sh('agent workflow run bypass.workflow.js --concurrency 2');
      const id = started.out.split('\n')[0];
      await window.held(2);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const during = (await window.stats()).active;
      window.release('burst');
      const waited = await window.sh(`agent workflow wait ${id}`);
      const most = (await window.stats()).most;
      const before = (await window.stats()).prompts.length;
      const budgeted = await window.sh('agent workflow run burst.workflow.js --budget 5 --wait');
      const status = await window.sh('agent workflow list');
      const ran = (await window.stats()).prompts.length - before;
      return { during, most, waited, budgeted, ran, status };
    },
    bypass,
    burst
  );
  assert.equal(seen.waited.code, 0, seen.waited.out);
  const result = JSON.parse(seen.waited.out);
  assert.equal(result.reach, 'undefined,undefined,undefined,undefined,undefined,undefined');
  assert.deepEqual(result.direct, ['direct 1', 'direct 2', 'direct 3', 'direct 4', 'direct 5']);
  assert.equal(seen.during, 2);
  assert.equal(seen.most, 2);
  assert.equal(seen.budgeted.code, 0, seen.budgeted.out);
  assert.deepEqual(JSON.parse(seen.budgeted.out), {
    first: ['twenty characters', 'twenty characters', 'twenty characters'],
    after: 'agent(): the budget of 5 output tokens is spent',
    spent: 15,
  });
  assert.equal(seen.ran, 3);
});

test('agent workflow stop withdraws the running scoops, and save keeps the source to run again by name', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const source = workflow(
    "const kept = await agent('say kept');\nawait agent('hold forever never');\nreturn kept;",
    'stoppable'
  );
  const quick = workflow("return agent('say again');", 'quick');
  const seen = await staged(
    page,
    'agent workflow stop withdraws',
    async (source, quick) => {
      await window.boot('');
      await window.put('/tmp/stoppable.js', source);
      const started = await window.sh('agent workflow run --script "$(cat /tmp/stoppable.js)"');
      const id = started.out.split('\n')[0];
      await window.held(1);
      const during = await window.sh('agent list');
      const stopped = await window.sh(`agent workflow stop ${id}`);
      const status = await window.sh(`agent workflow status ${id}`);
      const after = await window.sh('agent list');
      const saved = await window.sh(`agent workflow save ${id} stoppable`);
      const again = await window.sh(`agent workflow save ${id} stoppable`);
      const file = await window.sh('cat /home/.slicc/workflows/stoppable.workflow.js');
      await window.put('/home/quick.workflow.js', quick);
      const first = await window.sh('agent workflow run quick.workflow.js --wait');
      const listed = await window.sh('agent workflow list');
      const quickId = listed.out.trim().split('\n').at(-1).split('\t')[0];
      await window.sh(`agent workflow save ${quickId} quick-one`);
      const byName = await window.sh('agent workflow run quick-one --wait');
      return { started, during, stopped, status, after, saved, again, file, first, byName };
    },
    source,
    quick
  );
  assert.equal(seen.started.code, 0, seen.started.out);
  assert.match(seen.during.out, /^workflow-2\tworkflow\t-\tworking$/m);
  assert.match(seen.stopped.out, /is stopped\n$/);
  assert.match(seen.status.out, /\(stopped\)/);
  assert.equal(seen.after.out, 'no scoops\n');
  assert.equal(seen.saved.code, 0, seen.saved.out);
  assert.match(seen.saved.out, /\/home\/\.slicc\/workflows\/stoppable\.workflow\.js/);
  assert.equal(seen.again.code, 1);
  assert.match(seen.again.out, /already exists \(pass --force to overwrite\)/);
  assert.equal(seen.file.out, source);
  assert.equal(seen.first.out, '"again"\n');
  assert.equal(seen.byName.code, 0, seen.byName.out);
  assert.equal(seen.byName.out, '"again"\n');
});

test('a workflow run survives a page reload mid-run, and no finished step runs twice', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const persist = `/.slicc/workflow-${Date.now()}`;
  const source = workflow(
    [
      "const first = await agent('say before the reload');",
      "const second = await agent('hold reload after the reload');",
      "const third = await agent('say at the end');",
      'return [first, second, third];',
    ].join('\n'),
    'reloaded'
  );
  const before = await staged(
    page,
    'a workflow run before the reload',
    async (source, persist) => {
      await window.boot(`persist=${persist}`);
      await window.put('/home/reload.workflow.js', source);
      const started = await window.sh('agent workflow run reload.workflow.js');
      await window.held(1);
      return { started, prompts: (await window.stats()).prompts };
    },
    source,
    persist
  );
  assert.equal(before.started.code, 0, before.started.out);
  assert.deepEqual(before.prompts, ['say before the reload', 'hold reload after the reload']);
  const id = before.started.out.split('\n')[0];
  await page.reload();
  const after = await staged(
    page,
    'the workflow run after the reload',
    async (persist, id) => {
      await window.boot(`persist=${persist}`);
      await window.held(1);
      window.release('reload');
      const waited = await window.sh(`agent workflow wait ${id}`);
      const status = await window.sh(`agent workflow status ${id}`);
      const asked = (await window.requests())
        .filter((text) => text.includes('hold reload after the reload'))
        .map((text) => text.split('hold reload after the reload').length - 1);
      return { waited, status, prompts: (await window.stats()).prompts, asked };
    },
    persist,
    id
  );
  assert.equal(after.waited.code, 0, after.waited.out);
  assert.deepEqual(JSON.parse(after.waited.out), [
    'before the reload',
    'after the reload',
    'at the end',
  ]);
  assert.deepEqual(after.prompts, ['hold reload after the reload', 'say at the end']);
  assert.match(after.status.out, /agents: 3 done, 0 failed, 0 running, 3 started/);
  assert.deepEqual(after.asked, [1]);
});

test('the cone runs a workflow through its workflow tool and gets the result back', async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  const script = workflow("return { answer: await agent('say from the tool') };", 'tooled');
  const step = encodeURIComponent(
    JSON.stringify({ tool: { name: 'workflow', args: { action: 'run', script, wait: true } } })
  );
  const seen = await staged(
    page,
    'the cone runs a workflow through its tool',
    async (step) => {
      await window.boot(`step=${step}&answer=Ran.`);
      const answer = await window.connection.prompt('Run the workflow.');
      const results = window.connection.transcript.value.entries
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''));
      const listed = await window.sh('agent workflow list');
      const offered = (await window.requests()).map((text) => ({
        scoop: text.includes('You are the scoop'),
        workflow: text.includes('"name":"workflow"'),
      }));
      return { answer, results, listed, offered };
    },
    step
  );
  assert.equal(seen.answer, 'Ran.');
  assert.deepEqual(
    seen.results.map((text) => JSON.parse(text)),
    [{ answer: 'from the tool' }]
  );
  assert.match(seen.listed.out, /\tcompleted\t1\/1\ttooled\n$/);
  assert.ok(seen.offered.some((request) => !request.scoop && request.workflow));
  assert.ok(seen.offered.some((request) => request.scoop));
  assert.ok(seen.offered.every((request) => !request.scoop || !request.workflow));
});

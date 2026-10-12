import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const script = 'panel open files --left chat; echo "exit=$?"';

test('panel reaches only the tab showing the caller cone, through the production worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = [
    `step=${encodeURIComponent(JSON.stringify({ tool: { name: 'bash', args: { command: script } } }))}`,
    `step=${encodeURIComponent(JSON.stringify({ answer: 'Opened.' }))}`,
  ].join('&');
  const seen = await page.evaluate(async (q) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${q}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const until = async (check) => {
      for (let n = 0; n < 500 && !(await check()); n++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      return check();
    };
    const runs = { A: [], B: [], viewer: [] };
    const hang = { started: false };
    const runner = (name) => async (argv, caller) => {
      runs[name].push({ argv, caller });
      if (argv[0] === 'hang') {
        hang.started = true;
        return new Promise(() => undefined);
      }
      return { stdout: `${name} ran ${argv.join(' ')}\n`, stderr: `${name} note\n`, code: 0 };
    };
    const first = await owner.connect();
    const a = createAgentModel(first, { page: { tab: 'A', run: runner('A') } });
    const b = createAgentModel(await owner.connect(), { page: { tab: 'B', run: runner('B') } });
    const viewer = createAgentModel(await owner.connect({ readOnly: true }), {
      page: { tab: 'viewer', run: runner('viewer') },
    });
    await a.agent.ready();
    await b.agent.ready();
    await viewer.page.done;
    const other = await first.control.createCone('other', BACKGROUND_CONTEXT);
    await until(() => b.agent.list().some((row) => row.id === other.id));
    b.agent.select(other.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    a.agent.select('cone');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const terminal = await attachKernel(await kernel.connect());
    const run = async (command) => {
      const decoder = new TextDecoder();
      let out = '';
      let err = '';
      const process = await terminal.spawn(['bash', '-c', command], {
        cwd: '/home',
        onStdout: (bytes) => {
          out += decoder.decode(bytes);
        },
        onStderr: (bytes) => {
          err += decoder.decode(bytes);
        },
      });
      return { code: await process.exited, out, err };
    };
    await until(() => terminal.fs.exists('/usr/local/bin/panel'));
    const answer = await first.prompt('Open the files.');
    const tools = a.agent
      .messages('cone')
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool.output);
    const scoop = await first.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const fromScoop = await run(`SLICC_AGENT=${scoop.id} panel list --json`);
    const fromTab = await run('SLICC_TAB=B panel list');
    const pending = run('panel hang');
    await until(() => hang.started);
    await first.close();
    await a.page.dispose();
    const hung = await pending;
    await b.page.dispose();
    const none = await run('panel list');
    await owner.release();
    return {
      answer,
      tool: typeof tools[0] === 'string' ? tools[0] : JSON.stringify(tools[0]),
      runs,
      scoop: scoop.id,
      other: other.id,
      fromScoop,
      fromTab,
      hung,
      none,
    };
  }, query);
  assert.equal(seen.answer, 'Opened.');
  assert.match(seen.tool, /A ran open files --left chat/);
  assert.match(seen.tool, /A note/);
  assert.match(seen.tool, /exit=0/);
  assert.deepEqual(seen.runs.viewer, []);
  assert.deepEqual(seen.runs.A.slice(0, 2), [
    {
      argv: ['open', 'files', '--left', 'chat'],
      caller: { agentId: 'cone', cone: 'cone', readOnly: false },
    },
    { argv: ['list', '--json'], caller: { agentId: seen.scoop, cone: 'cone', readOnly: false } },
  ]);
  assert.deepEqual(seen.runs.B, [
    { argv: ['list'], caller: { agentId: null, cone: seen.other, readOnly: false } },
  ]);
  assert.deepEqual(seen.fromScoop, { code: 0, out: 'A ran list --json\n', err: 'A note\n' });
  assert.deepEqual(seen.fromTab, { code: 0, out: 'B ran list\n', err: 'B note\n' });
  assert.equal(seen.hung.code, 4);
  assert.match(seen.hung.err, /panel: the tab showing cone cone didn't answer; try again/);
  assert.equal(seen.none.code, 3);
  assert.match(seen.none.err, /panel: no open SLICC tab shows cone cone/);
});

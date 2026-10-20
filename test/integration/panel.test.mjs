import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const script = 'panel open files --left chat; echo "exit=$?"';

test("panel runs spectrum's panelCommand in the tab showing the caller cone, through the production worker", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const query = [
    `step=${encodeURIComponent(JSON.stringify({ tool: { name: 'bash', args: { command: script } } }))}`,
    `step=${encodeURIComponent(JSON.stringify({ answer: 'Opened.' }))}`,
  ].join('&');
  await staged(page, 'spectrum', async () => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    const { panelCommand } = await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    globalThis.spectrum = { panelCommand, createDummyModel };
  });
  await staged(
    page,
    'the panel tabs',
    async (q) => {
      await import('/dist-test/page.js');
      stage('the kernel');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      stage('the agent');
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${q}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
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
      const { panelCommand, createDummyModel } = globalThis.spectrum;
      const app = document.createElement('slicc-app');
      app.style.cssText = 'display:block;width:1400px;height:900px';
      document.body.append(app);
      const real = async (argv, caller) => {
        runs.A.push({ argv, caller });
        if (argv[0] !== 'hang') return panelCommand(app, argv, caller);
        hang.started = true;
        return new Promise(() => undefined);
      };
      const first = await owner.connect();
      const a = createAgentModel(first, { storage: localStorage, page: { tab: 'A', run: real } });
      app.model = { ...createDummyModel({ storage: localStorage }), ...a };
      await customElements.whenDefined('slicc-app');
      await when([every(50)], () => app.panels, 'the app panels');
      stage('the other tabs');
      const second = await owner.connect();
      const b = createAgentModel(second, { page: { tab: 'B', run: runner('B') } });
      const viewer = createAgentModel(await owner.connect({ readOnly: true }), {
        page: { tab: 'viewer', run: runner('viewer') },
      });
      await a.agent.ready();
      await b.agent.ready();
      await viewer.page.done;
      const other = await first.control.createCone('other', BACKGROUND_CONTEXT);
      await when(
        agentSources(second, b),
        () => b.agent.list().some((row) => row.id === other.id),
        'the other cone in tab B'
      );
      b.agent.select(other.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      a.agent.select('cone');
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      const terminal = await attachKernel(await kernel.connect());
      const run = async (command, quiet = false) => {
        if (!quiet) stage(command);
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
      await when(
        [files(kernel, ['/usr/local/bin'])],
        () => terminal.fs.exists('/usr/local/bin/panel'),
        'the panel command'
      );
      await when(
        [every(50)],
        async () => {
          const { out } = await run('panel tabs --json', true);
          const shown = out.startsWith('[') ? JSON.parse(out) : [];
          const tab = (id) => shown.find((row) => row.tab === id)?.cone;
          return tab('A') === 'cone' && tab('B') === other.id;
        },
        'both tabs reported'
      );
      globalThis.panelTest = { owner, first, a, b, app, run, other, hang, runs, kernel };
    },
    query
  );
  const seen = await staged(page, 'the panel commands', async () => {
    const { first, a, app, run, other } = globalThis.panelTest;
    stage('the answer');
    const answer = await first.prompt('Open the files.');
    stage('the scoop and its commands');
    const files = app.panels.find('files');
    const tools = a.agent
      .messages('cone')
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => part.tool.output);
    const scoop = await first.control.createScoop('cone', 'helper', BACKGROUND_CONTEXT);
    const fromScoop = await run(`SLICC_AGENT=${scoop.id} panel list --json`);
    const missing = await run(`SLICC_AGENT=${scoop.id} panel open chat:${other.id}`);
    const fromTab = await run('SLICC_TAB=B panel list');
    const tabs = await run('panel tabs --json');
    const pinned = await run('SLICC_TAB=A panel list --tab B');
    const fenced = await run(`SLICC_AGENT=${scoop.id} panel list --tab B`);
    const scoopTabs = await run(`SLICC_AGENT=${scoop.id} panel tabs`);
    const sprinkle = await run('command -v sprinkle');
    return {
      tabs,
      pinned,
      fenced,
      scoopTabs,
      sprinkle,
      answer,
      tool: typeof tools[0] === 'string' ? tools[0] : JSON.stringify(tools[0]),
      scoop: scoop.id,
      fromScoop,
      missing,
      files: files && { open: files.open, visible: files.visible },
      fromTab,
    };
  });
  const ended = await staged(page, 'the hung panel command', async () => {
    const { panelTest } = globalThis;
    const { owner, first, a, b, run, hang, runs } = panelTest;
    const pending = run('panel hang');
    await when([every(50)], () => hang.started, 'the hung command');
    stage('the closed tabs');
    await first.close();
    await a.page.dispose();
    const hung = await pending;
    await b.page.dispose();
    const none = await run('panel list');
    await owner.release();
    return { runs, other: panelTest.other.id, hung, none };
  });
  const scoop = seen.scoop;
  const other = ended.other;
  const runs = ended.runs;
  assert.equal(seen.answer, 'Opened.');
  assert.equal(seen.tool, 'opened files\nexit=0\n');
  assert.deepEqual(seen.files, { open: true, visible: true });
  assert.deepEqual(runs.viewer, []);
  assert.deepEqual(runs.A.slice(0, 3), [
    {
      argv: ['open', 'files', '--left', 'chat'],
      caller: { agentId: 'cone', cone: 'cone', readOnly: false },
    },
    { argv: ['list', '--json'], caller: { agentId: scoop, cone: 'cone', readOnly: false } },
    {
      argv: ['open', `chat:${other}`],
      caller: { agentId: scoop, cone: 'cone', readOnly: false },
    },
  ]);
  assert.deepEqual(runs.B, [
    { argv: ['list'], caller: { agentId: null, cone: other, readOnly: false } },
    { argv: ['list'], caller: { agentId: null, cone: other, readOnly: false } },
  ]);
  assert.equal(seen.tabs.code, 0);
  assert.deepEqual(
    JSON.parse(seen.tabs.out)
      .map((row) => [row.tab, row.cone])
      .sort(),
    [
      ['A', 'cone'],
      ['B', other],
    ]
  );
  assert.deepEqual(seen.pinned, { code: 0, out: 'B ran list\n', err: 'B note\n' });
  assert.deepEqual(seen.fenced, {
    code: 3,
    out: '',
    err: 'panel: no open SLICC tab B shows cone cone; panel tabs lists the ones that do\n',
  });
  assert.equal(seen.scoopTabs.code, 0);
  assert.match(seen.scoopTabs.out, /^A\tcone\t/);
  assert.equal(seen.scoopTabs.out.split('\n').length, 2);
  assert.equal(seen.sprinkle.code, 1);
  assert.equal(seen.fromScoop.code, 0);
  const listed = JSON.parse(seen.fromScoop.out).map((panel) => panel.id);
  assert.ok(listed.includes('files'));
  assert.ok(listed.includes('chat:cone'));
  assert.ok(!listed.includes(`chat:${other}`));
  assert.deepEqual(seen.missing, {
    code: 1,
    out: '',
    err: `panel: no panel called chat:${other}; panel list shows the ids you can use\n`,
  });
  assert.deepEqual(seen.fromTab, { code: 0, out: 'B ran list\n', err: 'B note\n' });
  assert.equal(ended.hung.code, 4);
  assert.match(ended.hung.err, /panel: the tab showing cone cone didn't answer; try again/);
  assert.equal(ended.none.code, 3);
  assert.match(ended.none.err, /panel: no open SLICC tab shows cone cone/);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const helpers = () => {
  window.boot = async (query, blocked) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel({}, { users: 'enforce' });
    window.sh = (command, user) => kernel.run(['bash', '-c', command], user ? { user } : {});
    window.owner = await startTracked({
      worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
      kernel: {
        connect: (options) =>
          options?.user === blocked
            ? Promise.reject(Object.assign(new Error('refused'), { code: 'EIO' }))
            : kernel.connect(options?.user ? { user: options.user } : undefined),
        users: kernel.users,
      },
    });
    window.model = createAgentModel(await window.owner.connect(), { storage: localStorage });
    window.agent = window.model.agent;
    await window.agent.ready();
  };
  window.licks = (agentId) =>
    window.agent
      .messages(agentId)
      .filter((message) => message.role === 'lick')
      .map(({ title }) => title);
};

const booted = async (t, blocked) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.goto('/');
  await staged(page, 'the agent', ([q, b]) => window.boot(q, b), ['answer=Done.', blocked]);
  await page.within(
    60000,
    async () => (await window.sh('test -d /var/lib/slicc/agent/requests/root/in')).status === 0
  );
  return page;
};

const watch = (path) => JSON.stringify({ path, glob: '**/*', debounce: 100 });

test("a cone's watches do not run when the cone's environment can't be resolved", async (t) => {
  const page = await booted(t, 'cone-2');
  await page.evaluate(
    async ([control, kept]) => {
      await window.sh('mkdir -p /root/kept /tmp/control && chmod 700 /root/kept');
      window.second = (await window.agent.createCone('second')).id;
      window.agent.select(window.second);
      const put = (path, text) =>
        window.sh(`mkdir -p ${path.slice(0, path.lastIndexOf('/'))} && echo '${text}' > ${path}`);
      await put('/home/cone-2/.slicc/watches/kept.json', kept);
      await put('/root/.slicc/watches/control.json', control);
    },
    [watch('/tmp/control'), watch('/root/kept')]
  );
  const titles = await page.within(60000, async () => {
    await window.sh('touch /tmp/control/$RANDOM /root/kept/$RANDOM');
    const titles = window.licks(window.second);
    return titles.filter((title) => title.startsWith('control:')).length > 1 ? titles : undefined;
  });
  assert.deepEqual(
    titles.filter((title) => !title.startsWith('control:')),
    []
  );
});

test("gelatiere init refuses when the first cone's environment can't be resolved, and writes no procedure", async (t) => {
  const page = await booted(t, 'cone');
  const seen = await page.evaluate(async () => {
    const init = await window.sh('gelatiere init');
    const procedure = await window.sh('test -e /home/cone/.pi/agent/GELATIERE.md');
    return { init, procedure: procedure.status };
  });
  assert.equal(seen.procedure, 1);
  assert.equal(seen.init.status, 1, seen.init.stdout + seen.init.stderr);
  assert.match(
    seen.init.stdout + seen.init.stderr,
    /can't find the environment that owns \/home\/cone\/.pi\/agent\/GELATIERE.md/
  );
});

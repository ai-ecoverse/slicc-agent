import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const SPOOLS = '/var/lib/slicc/agent/requests';

const helpers = () => {
  window.boot = async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel({}, { users: 'enforce' });
    window.kernel = kernel;
    window.sh = (command, user) => kernel.run(['bash', '-c', command], user ? { user } : {});
    window.owner = await startTracked({
      worker: () =>
        new Worker('/dist-test/main-worker.js?persist=/spools-restart', { type: 'module' }),
      kernel: {
        connect: (options) => kernel.connect(options?.user ? { user: options.user } : undefined),
        users: kernel.users,
      },
    });
    window.connect = async () => {
      window.model = createAgentModel(await window.owner.connect(), { storage: localStorage });
      window.agent = window.model.agent;
      await window.agent.ready();
    };
    await window.connect();
  };
  window.spools = async () =>
    (
      await window.sh(
        `stat -c '%n %U:%G %a' ${SPOOLS}/cone-2 ${SPOOLS}/cone-3/out ${SPOOLS}/cone-4/in ${SPOOLS}/cone-5/out`
      )
    ).stdout;
  window.ctimes = async () =>
    (await window.sh(`stat -c '%n %z' ${SPOOLS}/cone-5 ${SPOOLS}/cone-5/in ${SPOOLS}/cone-5/out`))
      .stdout;
  window.answers = async () => {
    const out = {};
    for (const user of ['cone-2', 'cone-3', 'cone-4', 'cone-5']) {
      const { status, stdout, stderr } = await window.sh('agent list --cones', user);
      out[user] =
        status === 0 && stdout.includes(`${user}\t`) ? 'served' : `${status} ${stdout}${stderr}`;
    }
    return out;
  };
};

test('a worker restart puts back the spools that lost their folder or mode, never chowns or chmods the spools in place again, and serves every cone’s agent command', {
  timeout: 240000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.init(helpers);
  await page.init(`() => { window.SPOOLS = ${JSON.stringify(SPOOLS)}; }`);
  await page.goto('/');
  await staged(page, 'the agent', () => window.boot());
  const seen = await staged(page, 'the restart', async () => {
    for (const name of ['second', 'third', 'fourth', 'fifth']) await window.agent.createCone(name);
    const placed = [
      `${SPOOLS}/cone-2 cone-2:cone-2 700`,
      `${SPOOLS}/cone-3/out cone-3:cone-3 700`,
      `${SPOOLS}/cone-4/in cone-4:cone-4 700`,
      `${SPOOLS}/cone-5/out cone-5:cone-5 700`,
      '',
    ].join('\n');
    await when(
      [every(100)],
      async () => (await window.spools()) === placed,
      'the new cones’ spools'
    );
    const before = await window.spools();
    const untouched = await window.ctimes();
    const broken = await window.sh(
      `chmod 755 ${SPOOLS}/cone-2 && rm -rf ${SPOOLS}/cone-3 && chown root:root ${SPOOLS}/cone-4/in`
    );
    await window.owner.restart();
    await window.connect();
    await when(
      [every(100)],
      async () => (await window.spools()) === before,
      'the spools put back after the restart'
    );
    return {
      before,
      broken: broken.status,
      untouched: [untouched, await window.ctimes()],
      answers: await window.answers(),
    };
  });
  assert.equal(seen.broken, 0);
  assert.equal(
    seen.before,
    [
      `${SPOOLS}/cone-2 cone-2:cone-2 700`,
      `${SPOOLS}/cone-3/out cone-3:cone-3 700`,
      `${SPOOLS}/cone-4/in cone-4:cone-4 700`,
      `${SPOOLS}/cone-5/out cone-5:cone-5 700`,
      '',
    ].join('\n')
  );
  assert.match(seen.untouched[0], /cone-5\/out /);
  assert.equal(
    seen.untouched[1],
    seen.untouched[0],
    'the spools in place were not chowned or chmodded again'
  );
  assert.deepEqual(seen.answers, {
    'cone-2': 'served',
    'cone-3': 'served',
    'cone-4': 'served',
    'cone-5': 'served',
  });
  assert.deepEqual(page.errors, []);
});

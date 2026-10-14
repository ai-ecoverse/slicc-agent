import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const kernelVersion = JSON.parse(
  await readFile(
    new URL('../../node_modules/@ai-ecoverse/slicc-kernel/package.json', import.meta.url)
  )
)
  .version.split('.')
  .map(Number);
const timesKernel = kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= 67);

const chrome = await launch();
after(() => chrome.close());

test('the live monitor through the production worker: it runs only while the panel listens, shows the agent background process, and a view-only connection sees program names only', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
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
    await connection.prompt('Start a sleeper.');
    const idle = connection.monitor.value;
    const model = createAgentModel(connection);
    const wait = async (check) => {
      for (let tries = 0; tries < 300; tries++) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    };
    const snapshots = [];
    const off = model.monitor.on('snapshot', (snapshot) => snapshots.push(snapshot));
    const shown = await wait(() => {
      const snapshot = model.monitor.snapshot();
      const processes = snapshot.sections.find((section) => section.id === 'processes');
      return processes?.rows.some((row) => row.name.includes('--token=[redacted]')) && snapshot;
    });
    const full = connection.monitor.value;
    const timed = full.processes.some((row) => typeof row.utime === 'number');
    const measured = timed
      ? await wait(() => {
          const feed = connection.monitor.value;
          const spin = feed.processes?.find((row) => row.command.includes('while :'));
          return spin && typeof spin.cpu === 'number' && spin.cpu > 0 && feed;
        })
      : null;
    const trended = await wait(() => {
      const vitals = model.monitor.snapshot().vitals;
      return vitals.find((vital) => vital.id === 'processes')?.series && vitals;
    });
    const viewed = await wait(
      () => viewer.monitor.value?.processes?.length && viewer.monitor.value
    );
    off();
    const closed = await wait(
      () => connection.monitor.value.open === false && connection.monitor.value
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
      agentKeys: Object.keys(full.agents[0]),
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
  assert.equal(seen.timed, timesKernel);
  if (timesKernel) {
    assert.ok(seen.keys.includes('utime') && seen.keys.includes('stime'));
    assert.equal(typeof seen.spin.utime, 'number');
    assert.ok(seen.spin.cpu > 0);
    assert.equal(seen.spin.agentId, 'cone');
    assert.ok(seen.cone.cpu >= seen.spin.cpu);
  } else {
    assert.ok(!['utime', 'stime', 'cpu'].some((key) => seen.keys.includes(key)));
    assert.ok(!seen.agentKeys.includes('cpu'));
  }
});

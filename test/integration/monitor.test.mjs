import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

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
            command: "bash -c 'sleep 30; true' x --token=sekrit123 >/dev/null 2>&1 & echo started",
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
      agents: shown?.sections.find((section) => section.id === 'agents').rows,
      full: full.processes.map((row) => row.command),
      viewed: viewed?.processes.map((row) => row.command),
      usage: full.usage,
      snapshots: snapshots.length,
      closed: Boolean(closed),
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
  assert.equal(seen.agents[0].name, 'sliccy');
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
});

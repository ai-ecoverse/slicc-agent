import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const FIXTURE = readFileSync(new URL('./fixtures/pi-1.5.2-session.sqlite.gz', import.meta.url));

test('a session pi-durable 1.5.2 wrote mid-run, with its model call and tool call live, opens under this pi-durable and finishes that run', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'the 1.5.2 session',
    async (fixture) => {
      await import('/dist-test/page.js');
      const run = (query, message) =>
        new Promise((resolve) => {
          const worker = new Worker(`/dist-test/upgrade-worker.js?${query}`, { type: 'module' });
          worker.onmessage = ({ data }) => {
            worker.terminate();
            resolve(data);
          };
          if (message) worker.postMessage(message);
        });
      const directory = 'directory=/pi-upgrade';
      const bytes = Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0));
      stage('import the fixture');
      const imported = await run(`mode=import&${directory}`, { fixture: bytes });
      if (imported.error) return imported;
      stage('resume it');
      const resumed = await run(`mode=resume&${directory}`);
      if (resumed.error) return resumed;
      stage('read it back');
      const read = await run(`mode=read&${directory}`);
      return { imported: imported.tasks, resumed, read: read.tasks ?? read };
    },
    FIXTURE.toString('base64')
  );
  assert.equal(seen.error, undefined, seen.error);
  assert.deepEqual(seen.imported, [
    { kind: 'pi.generation', status: 'waiting', version: 2 },
    { kind: 'pi.tool', status: 'running', version: 3 },
  ]);
  assert.deepEqual(
    seen.resumed.before.sort((one, other) => one.kind.localeCompare(other.kind)),
    [
      { kind: 'pi.generation', version: 2, state: 'waiting' },
      { kind: 'pi.tool', version: 3, state: 'pending', migrates: true },
    ]
  );
  assert.equal(seen.resumed.idle, true);
  assert.deepEqual(seen.resumed.after, []);
  assert.deepEqual(seen.resumed.users, ['Hold on.']);
  assert.deepEqual(seen.resumed.results, ['held']);
  assert.deepEqual(seen.resumed.answers, ['', 'Resumed.']);
  assert.deepEqual(seen.read, [
    { kind: 'pi.generation', status: 'terminal', version: 3 },
    { kind: 'pi.tool', status: 'terminal', version: 4 },
    { kind: 'pi.generation', status: 'terminal', version: 3 },
  ]);
});

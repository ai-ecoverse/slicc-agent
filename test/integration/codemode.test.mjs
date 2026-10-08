import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('codemode runs QuickJS in a nested worker of the production agent worker and calls its tools', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const code = [
      'const echoed = await tools.bash({ command: "echo from-bash" });',
      'const failed = await tools.bash({ command: "exit 4" });',
      'store("seen", 1);',
      'text(echoed.output.trim() + " " + failed.exit_code);',
      'return load("seen");',
    ].join('\n');
    const params = new URLSearchParams([
      ['code', code],
      ['answer', 'Done.'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const answer = await connection.prompt('Run the script.');
    const results = connection.transcript.value.entries
      .filter((entry) => entry.kind === 'pi.tool-result')
      .map((entry) => entry.model[0].content.map((part) => part.text ?? '').join(''));
    await owner.release();
    return { answer, results, isolated: crossOriginIsolated };
  });
  assert.equal(seen.isolated, true);
  assert.equal(seen.answer, 'Done.');
  assert.equal(seen.results.length, 1);
  assert.match(
    seen.results[0],
    /^Script completed\nWall time \d+\.\d seconds\nOutput:\n==> text 1\/2 <==\nfrom-bash 4\n==> text 2\/2 <==\n1$/
  );
});

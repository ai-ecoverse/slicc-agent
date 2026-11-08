import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('reading an image through slicc-images does not report a missing structuredOutput', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [{ tool: { name: 'read', args: { path: '/tmp/wide.png' } } }, { answer: 'Seen.' }];
  const seen = await staged(
    page,
    'image read structuredOutput',
    async (steps) => {
      const { bootKernel } = await import('/kernel.js');
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const client = await attachKernel(await kernel.connect());
      const canvas = new OffscreenCanvas(2400, 60);
      const draw = canvas.getContext('2d');
      draw.fillStyle = '#5b8def';
      draw.fillRect(0, 0, 2400, 60);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await client.fs.writeFile('/tmp/wide.png', new Uint8Array(await blob.arrayBuffer()));
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      const owner = await startTracked({
        worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      await model.agent.ready();
      await model.agent.send('cone', 'Read the image.');
      await when(
        [changed, every(100)],
        () =>
          model.agent
            .messages('cone')
            .some((message) => message.parts?.some((part) => part.text === 'Seen.')),
        'the answer'
      );
      const results = (connection.transcript.value?.entries ?? [])
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) => ({
          name: entry.model[0].toolName,
          text: (entry.model[0].content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
          images: (entry.model[0].content ?? []).filter((block) => block.type === 'image').length,
        }));
      const problems = (connection.monitor.value?.problems ?? []).filter(
        (problem) =>
          problem.report?.source === 'slicc-images' ||
          /structuredOutput/i.test(problem.message ?? '')
      );
      await owner.release();
      return {
        results,
        problems: problems.map((problem) => ({
          message: problem.message,
          report: problem.report,
        })),
      };
    },
    steps
  );
  assert.equal(seen.results.length, 1);
  assert.equal(seen.results[0].name, 'read');
  assert.match(seen.results[0].text, /\/tmp\/wide\.png \(image\/(png|jpeg), \d+ bytes\)/);
  assert.equal(seen.results[0].images, 1);
  assert.deepEqual(seen.problems, []);
});

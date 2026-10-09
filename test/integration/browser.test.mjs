import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a playwright-cli screenshot read back shows on the tool card, through the production worker', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async (png) => {
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    const client = await attachKernel(await kernel.connect());
    const script = [
      '#!/bin/bash',
      'for arg in "$@"; do',
      `  if [ "$previous" = --filename ]; then echo '${png}' | base64 -d > "$arg"; fi`,
      '  previous="$arg"',
      'done',
      'echo "Screenshot saved"',
    ].join('\n');
    await client.fs.mkdir('/home/.local/share/pnpm/bin', { recursive: true });
    await client.fs.writeFile('/home/.local/share/pnpm/bin/playwright-cli', `${script}\n`);
    const params = new URLSearchParams([
      [
        'tool',
        JSON.stringify({
          name: 'bash',
          args: {
            command:
              'chmod +x /home/.local/share/pnpm/bin/playwright-cli && playwright-cli screenshot --tab t1 --max-width 1600 --filename /tmp/shot.png',
          },
        }),
      ],
      ['tool', JSON.stringify({ name: 'read', args: { path: '/tmp/shot.png' } })],
      ['answer', 'It is a single pixel.'],
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    const answer = await connection.prompt('Take a screenshot.');
    await model.agent.ready();
    const tools = model.agent
      .messages(model.agent.active())
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === 'tool')
      .map((part) => ({
        name: part.tool.name,
        output: part.tool.output,
        image: part.tool.image ?? null,
      }));
    await owner.release();
    return { answer, tools };
  }, PNG);
  assert.equal(seen.answer, 'It is a single pixel.');
  assert.equal(seen.tools[0].name, 'bash');
  assert.match(seen.tools[0].output, /Screenshot saved/);
  assert.equal(seen.tools[1].name, 'read');
  assert.match(seen.tools[1].image, /^data:image\/png;base64,iVBORw0KGgo/);
});

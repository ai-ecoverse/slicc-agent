import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const bash = (command) => ({ tool: { name: 'bash', args: { command } } });
const marker = (path) => `echo '<img:${path}>'`;

test('a bash line <img:/path> shows the image on the tool card and to the model, with notes for what it cannot show', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    bash(
      `echo ${DOT} | base64 -d > /tmp/dot.png; echo before; ${marker('/tmp/dot.png')}; echo after`
    ),
    bash(marker('/tmp/noise.png')),
    bash(
      [
        marker('/tmp/missing.png'),
        marker('dot.png'),
        `${marker('/tmp/dot.png')} >&2`,
        'echo plain > /tmp/plain.txt',
        marker('/tmp/plain.txt'),
      ].join('; ')
    ),
    bash(`for i in 1 2 3 4 5; do ${marker('/tmp/dot.png')}; done; seq 1 3000`),
    { answer: 'Done.' },
  ];
  const seen = await staged(
    page,
    'a bash line img marker',
    async (steps) => {
      const { bootKernel } = await import('/kernel.js');
      const { attachKernel } = await import(
        '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js'
      );
      await import('/dist-test/page.js');
      const kernel = await bootKernel();
      const client = await attachKernel(await kernel.connect());
      const canvas = new OffscreenCanvas(1600, 2000);
      const draw = canvas.getContext('2d');
      const pixels = draw.createImageData(1600, 2000);
      for (let at = 0; at < pixels.data.length; at += 65536)
        crypto.getRandomValues(pixels.data.subarray(at, at + 65536));
      for (let at = 3; at < pixels.data.length; at += 4) pixels.data[at] = 255;
      draw.putImageData(pixels, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await client.fs.writeFile('/tmp/noise.png', new Uint8Array(await blob.arrayBuffer()));
      let worker;
      const params = new URLSearchParams(steps.map((step) => ['step', JSON.stringify(step)]));
      const owner = await startTracked({
        worker: () => {
          worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
          return worker;
        },
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      await model.agent.ready();
      await model.agent.send('cone', 'Show me the images.');
      await when(
        [changed, every(100)],
        () =>
          model.agent
            .messages('cone')
            .some((message) => message.parts?.some((part) => part.text === 'Done.')),
        'the answer'
      );
      const cards = model.agent
        .messages('cone')
        .flatMap((message) => (message.role === 'assistant' ? message.parts : []))
        .filter((part) => part.type === 'tool')
        .map((part) => ({
          output: part.tool.output,
          image: part.tool.image ?? null,
          notes: (part.tool.notes ?? []).map((note) => note.severity),
        }));
      const requests = await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data.map((text) => JSON.parse(text)));
        worker.postMessage({ requests: channel.port2 }, [channel.port2]);
      });
      const results = requests
        .at(-1)
        .messages.filter((message) => message.role === 'toolResult')
        .map((message) => ({
          text: message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
          images: message.content
            .filter((part) => part.type === 'image')
            .map(({ mimeType, data }) => ({ mimeType, data })),
        }));
      await owner.release();
      return { cards, results };
    },
    steps
  );
  const [shown, large, notes, many] = seen.results;
  assert.equal(shown.text, 'before\n/tmp/dot.png (image/png, 70 bytes)\nafter\n');
  assert.deepEqual(shown.images, [{ mimeType: 'image/png', data: DOT }]);
  assert.equal(seen.cards[0].image, `data:image/png;base64,${DOT}`);
  assert.match(seen.cards[0].output, /^before\n\/tmp\/dot\.png \(image\/png, 70 bytes\)\nafter/);
  assert.match(
    large.text,
    /^\/tmp\/noise\.png is too large to show as an image \(\d+ bytes after fitting it to 1600 px\)\.\n$/
  );
  assert.deepEqual(large.images, []);
  assert.equal(seen.cards[1].image, null);
  assert.equal(
    notes.text,
    [
      '/tmp/missing.png could not be read (not_found).',
      'dot.png is not an absolute path, so it was not read.',
      '<img:/tmp/dot.png>',
      '/tmp/plain.txt is not a PNG, JPEG, GIF or WebP image.',
      '',
    ].join('\n')
  );
  assert.deepEqual(notes.images, []);
  assert.equal(many.images.length, 4);
  assert.match(many.text, /\n3000\n\/tmp\/dot\.png \(image\/png, 70 bytes\)\n/);
  assert.match(
    many.text,
    /\n1 more image line was not shown: a command shows at most 4 images\.\n<harness>\n\[info\] Full output: [^\n]+\n\[warn\] Output truncated to its end: 1010 lines, \d+ bytes dropped\n<\/harness>$/
  );
  assert.doesNotMatch(many.text, /<img:/);
  assert.equal(seen.cards[3].image, `data:image/png;base64,${DOT}`);
  assert.ok(seen.cards[3].notes.includes('warn'));
});

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function shot(page) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  return Buffer.from(data, 'base64');
}

async function boot(page, query) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.goto('/');
  await page.evaluate(async (query) => {
    const spectrum = '/node_modules/@ai-ecoverse/slicc-spectrum/dist';
    await import(`${spectrum}/slicc-ui.js`);
    const { createDummyModel } = await import(`${spectrum}/slicc-dummy.js`);
    const { bootKernel } = await import('/kernel.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const params = new URLSearchParams(query);
    let worker;
    const owner = await startAgent({
      worker: () => {
        worker = new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' });
        return worker;
      },
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    const app = document.createElement('slicc-app');
    app.style.cssText = 'display:block;width:100vw;height:100vh';
    document.body.style.margin = '0';
    document.body.append(app);
    app.model = { ...createDummyModel({ storage: localStorage }), ...model };
    await customElements.whenDefined('slicc-app');
    await model.agent.ready();
    const find = (root, selector) => {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const node of root.querySelectorAll('*'))
        if (node.shadowRoot) {
          const inner = find(node.shadowRoot, selector);
          if (inner) return inner;
        }
      return null;
    };
    const requests = () =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = ({ data }) => resolve(data.map((text) => JSON.parse(text)));
        worker.postMessage({ requests: channel.port2 }, [channel.port2]);
      });
    const files = (list) => {
      const transfer = new DataTransfer();
      for (const { name, type, base64, text } of list)
        transfer.items.add(
          new File([base64 ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) : text], name, {
            type,
          })
        );
      return transfer;
    };
    const composer = () => find(document, 'slicc-composer');
    const answered = (count) =>
      model.agent
        .messages('cone')
        .filter((m) => m.role === 'assistant' && m.parts.some((part) => part.type === 'text'))
        .length >= count && !model.agent.busy('cone');
    const client = await attachKernel(await kernel.connect());
    globalThis.attach = { model, find, requests, files, composer, answered, client };
  }, query);
}

const users = (requests) =>
  requests
    .at(-1)
    .messages.filter((message) => message.role === 'user')
    .at(-1).content;

async function dummyImage(page) {
  return page.evaluate(async () => {
    const canvas = new OffscreenCanvas(320, 200);
    const draw = canvas.getContext('2d');
    const fill = draw.createLinearGradient(0, 0, 320, 200);
    fill.addColorStop(0, '#5b8def');
    fill.addColorStop(1, '#d36ef0');
    draw.fillStyle = fill;
    draw.fillRect(0, 0, 320, 200);
    draw.fillStyle = '#ffffff';
    draw.font = 'bold 36px sans-serif';
    draw.fillText('Dummy image', 52, 112);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
}

test('an image from +, paste and drop reaches the model as an image part with the same bytes', async (t) => {
  const page = await chrome.page(t);
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await boot(
    page,
    ['One.', 'Two.', 'Three.'].map((answer) => ['answer', answer])
  );
  const PNG = await dummyImage(page);
  const sources = ['plus', 'paste', 'drop'];
  for (const [at, source] of sources.entries()) {
    await page.evaluate(
      async ({ source, png }) => {
        const { composer, files } = globalThis.attach;
        const dt = files([{ name: `${source}.png`, type: 'image/png', base64: png }]);
        const shadow = composer().shadowRoot;
        if (source === 'plus') {
          const input = shadow.querySelector('input[type=file]');
          input.files = dt.files;
          input.dispatchEvent(new Event('change'));
        } else if (source === 'paste')
          shadow
            .querySelector('swc-prompt-field')
            .dispatchEvent(
              new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true })
            );
        else {
          const field = shadow.querySelector('swc-prompt-field');
          for (const type of ['dragenter', 'dragover', 'drop'])
            field.dispatchEvent(
              new DragEvent(type, {
                dataTransfer: dt,
                bubbles: true,
                composed: true,
                cancelable: true,
              })
            );
        }
      },
      { source, png: PNG }
    );
    await page.until(() => globalThis.attach.composer().attachments.length === 1);
    if (env.ATTACH_SHOTS && source === 'plus') {
      await page.evaluate(() => {
        globalThis.attach.composer().value = 'What is in this dummy image?';
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writeFile(`${env.ATTACH_SHOTS}/composer-image.png`, await shot(page));
    }
    await page.evaluate((source) => {
      const composer = globalThis.attach.composer();
      composer.value = `Look at the ${source} image.`;
      composer.send();
    }, source);
    await page.until((count) => globalThis.attach.answered(count), at + 1);
  }
  const requests = await page.evaluate(() => globalThis.attach.requests());
  const images = requests
    .at(-1)
    .messages.filter((message) => message.role === 'user')
    .map((message) => message.content.filter((part) => part.type === 'image'));
  assert.deepEqual(
    images.map((parts) => parts.map(({ mimeType, data }) => ({ mimeType, data }))),
    sources.map(() => [{ mimeType: 'image/png', data: PNG }])
  );
  const shown = await page.evaluate(() =>
    globalThis.attach.model.agent
      .messages('cone')
      .filter((message) => message.role === 'user')
      .map((message) => ({
        text: message.text,
        attachments: message.attachments.map(({ name, kind, url }) => ({ name, kind, url })),
      }))
  );
  assert.deepEqual(
    shown,
    sources.map((source) => ({
      text: `Look at the ${source} image.`,
      attachments: [{ name: `${source}.png`, kind: 'image', url: `data:image/png;base64,${PNG}` }],
    }))
  );
  const thumbnails = await page.until(() => {
    const transcript = globalThis.attach.find(document, 'slicc-transcript') ?? document;
    const found = [];
    const walk = (root) => {
      for (const node of root.querySelectorAll('.attachment.image img')) found.push(node.src);
      for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot);
    };
    walk(transcript.shadowRoot ?? transcript);
    return found.length >= 3 && found;
  });
  assert.ok(thumbnails.every((src) => src === `data:image/png;base64,${PNG}`));
  if (env.ATTACH_SHOTS) await writeFile(`${env.ATTACH_SHOTS}/sent-image.png`, await shot(page));
});

test('a text file arrives as text and a binary file as a saved file whose path is in the text', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    ['answer', 'Read it.'],
    ['answer', 'Saved it.'],
  ]);
  await page.evaluate(async () => {
    const { composer, files } = globalThis.attach;
    const input = composer().shadowRoot.querySelector('input[type=file]');
    input.files = files([
      { name: 'notes.md', type: 'text/markdown', text: '# Dummy notes\nline two' },
    ]).files;
    input.dispatchEvent(new Event('change'));
  });
  await page.until(() => globalThis.attach.composer().attachments.length === 1);
  await page.evaluate(() => {
    const composer = globalThis.attach.composer();
    composer.value = 'Summarize the notes.';
    composer.send();
  });
  await page.until(() => globalThis.attach.answered(1));
  const bytes = [0, 1, 2, 250, 255, 7];
  await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    await globalThis.attach.model.agent.send('cone', {
      text: 'Keep this.',
      attachments: [
        {
          id: 'a1',
          name: 'dummy.bin',
          kind: 'file',
          mimeType: 'application/octet-stream',
          size: bytes.length,
          url: URL.createObjectURL(blob),
        },
      ],
    });
  }, bytes);
  await page.until(() => globalThis.attach.answered(2));
  const requests = await page.evaluate(() => globalThis.attach.requests());
  const [notes, binary] = requests
    .at(-1)
    .messages.filter((message) => message.role === 'user')
    .map((message) => message.content);
  assert.equal(notes[0].text, 'Summarize the notes.');
  assert.equal(
    notes[1].text,
    '<attachment kind="text" name="notes.md" type="text/markdown">\n# Dummy notes\nline two\n</attachment>'
  );
  assert.equal(binary[0].text, 'Keep this.');
  const path = /path="([^"]+)"/.exec(binary[1].text)?.[1];
  assert.equal(path, '/home/uploads/dummy.bin');
  assert.match(binary[1].text, /Saved at \/home\/uploads\/dummy\.bin\./);
  assert.ok(binary.every((part) => part.type === 'text'));
  const saved = await page.evaluate(
    async (path) => [...(await globalThis.attach.client.fs.readFile(path))],
    path
  );
  assert.deepEqual(saved, bytes);
  const shown = await page.evaluate(() =>
    globalThis.attach.model.agent
      .messages('cone')
      .filter((message) => message.role === 'user')
      .map((message) =>
        message.attachments.map(({ name, kind, path }) => ({ name, kind, path: path ?? null }))
      )
  );
  assert.deepEqual(shown, [
    [{ name: 'notes.md', kind: 'text', path: null }],
    [{ name: 'dummy.bin', kind: 'file', path: '/home/uploads/dummy.bin' }],
  ]);
});

test('a model without image input gets the image as a saved file and a note', async (t) => {
  const page = await chrome.page(t);
  await boot(page, [
    ['blind', 'faux-1'],
    ['answer', 'I cannot see it.'],
  ]);
  await page.evaluate(async (png) => {
    const { composer, files } = globalThis.attach;
    const input = composer().shadowRoot.querySelector('input[type=file]');
    input.files = files([{ name: 'blind.png', type: 'image/png', base64: png }]).files;
    input.dispatchEvent(new Event('change'));
  }, PNG);
  await page.until(() => globalThis.attach.composer().attachments.length === 1);
  await page.evaluate(() => {
    const composer = globalThis.attach.composer();
    composer.value = 'What is this?';
    composer.send();
  });
  await page.until(() => globalThis.attach.answered(1));
  const requests = await page.evaluate(() => globalThis.attach.requests());
  const content = users(requests);
  assert.ok(content.every((part) => part.type === 'text'));
  assert.match(content[1].text, /path="\/home\/uploads\/blind\.png"/);
  assert.match(
    content[1].text,
    /This model can't see images, so the image was saved as a file instead\./
  );
  const saved = await page.evaluate(async () =>
    btoa(
      String.fromCharCode(
        ...(await globalThis.attach.client.fs.readFile('/home/uploads/blind.png'))
      )
    )
  );
  assert.equal(saved, PNG);
});

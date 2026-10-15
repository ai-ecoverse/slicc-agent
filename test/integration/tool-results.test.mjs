import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the model gets the text of MCP resource tools in a script, lick decisions, refused scoop reads and fitted wide images', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    {
      tool: {
        name: 'codemode',
        args: {
          code: 'const listed = await tools.list_mcp_resources({}); const read = await tools.read_mcp_resource({ server: "docs", uri: "note://1" }); text(listed); text(read);',
        },
      },
    },
    { tool: { name: 'lick_confirm', args: { lick_id: 'lk-nope', reason: 'fine' } } },
    { tool: { name: 'read', args: { path: '/tmp/wide.png' } } },
    { answer: 'Cone done.' },
    { tool: { name: 'read', args: { path: '/etc/hostname' } } },
    { answer: 'Scoop done.' },
  ];
  const seen = await page.evaluate(async (steps) => {
    const write = async (path, text) => {
      let dir = await navigator.storage.getDirectory();
      const parts = path.split('/').filter(Boolean);
      const name = parts.pop();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    await write(
      '/home/.pi/agent/mcp.json',
      JSON.stringify({ mcpServers: { docs: { url: 'https://mcp.test/mcp' } } })
    );
    const { bootKernel } = await import('/kernel.js');
    const { attachKernel } = await import('/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const client = await attachKernel(await kernel.connect());
    const canvas = new OffscreenCanvas(2400, 60);
    const draw = canvas.getContext('2d');
    draw.fillStyle = '#5b8def';
    draw.fillRect(0, 0, 2400, 60);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await client.fs.writeFile('/tmp/wide.png', new Uint8Array(await blob.arrayBuffer()));
    const params = new URLSearchParams([
      ['relay', 'mcp.test'],
      ...steps.map((step) => ['step', JSON.stringify(step)]),
    ]);
    const owner = await startAgent({
      worker: () => new Worker(`/dist-test/main-worker.js?${params}`, { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const connection = await owner.connect();
    const model = createAgentModel(connection, { storage: localStorage });
    await model.agent.ready();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const ctx = BACKGROUND_CONTEXT;
    await connection.prompt('Use the tools.');
    const scoop = await connection.control.createScoop('cone', 'probe', ctx);
    const sent = await connection.control.send(
      { text: 'Read the hostname.', whenBusy: 'followUp', requestId: null, agentId: scoop.id },
      ctx
    );
    await connection.control.wait(sent.submissionId, ctx);
    const results = (view) =>
      (view?.entries ?? [])
        .filter((entry) => entry.kind === 'pi.tool-result')
        .map((entry) => ({
          name: entry.model[0].toolName,
          text: (entry.model[0].content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
          images: (entry.model[0].content ?? []).filter((block) => block.type === 'image').length,
        }));
    const scoopView = () => connection.views.value?.[scoop.id];
    for (let i = 0; i < 200 && results(scoopView()).length < 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const result = { cone: results(connection.transcript.value), scoop: results(scoopView()) };
    await owner.release();
    return result;
  }, steps);
  const [scripted, decided, image] = seen.cone;
  assert.equal(scripted.name, 'codemode');
  assert.match(scripted.text, /"uri":"note:\/\/1"/);
  assert.match(scripted.text, /contents of note:\/\/1/);
  assert.equal(decided.name, 'lick_confirm');
  assert.match(decided.text, /There is no lick lk-nope in this conversation\./);
  assert.equal(image.name, 'read');
  assert.match(image.text, /\/tmp\/wide\.png \(image\/(png|jpeg), \d+ bytes\)/);
  assert.equal(image.images, 1);
  assert.equal(seen.scoop[0].name, 'read');
  assert.match(seen.scoop[0].text, /\/etc\/hostname is outside this scoop's folders\./);
});

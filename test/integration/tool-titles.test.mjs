import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

function query(steps) {
  return steps.map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`).join('&');
}

test('single tool cards get human titles while input stays the raw command or path', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    { tool: { name: 'bash', args: { command: 'git status -sb' } } },
    { tool: { name: 'read', args: { path: '/home/src/foo.ts' } } },
    { tool: { name: 'write', args: { path: '/home/src/bar.ts', content: 'x' } } },
    {
      tool: {
        name: 'edit',
        args: { path: '/home/src/baz.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      },
    },
    { tool: { name: 'mcp__docs__search', args: { query: 'notes' } } },
    { answer: 'Done.' },
  ];
  const seen = await staged(
    page,
    'single tool cards get human',
    async ({ query }) => {
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      const owner = await startAgent({
        worker: () => new Worker(`/dist-test/main-worker.js?${query}`, { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const model = createAgentModel(connection, { storage: localStorage });
      await model.agent.ready();
      await connection.prompt('Use the tools.');
      await when(
        agentSources(connection, model),
        () =>
          model.agent
            .messages('cone')
            .some(
              (message) =>
                message.role === 'assistant' && message.parts?.some((p) => p.text === 'Done.')
            ),
        'the answer'
      );
      const tools = model.agent
        .messages('cone')
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.parts.filter((part) => part.type === 'tool'))
        .map((part) => ({
          name: part.tool.name,
          title: part.tool.title,
          input: part.tool.input,
        }));
      await owner.release();
      return tools;
    },
    { query: query(steps) }
  );
  assert.deepEqual(seen, [
    { name: 'bash', title: 'Use the computer', input: 'git status -sb' },
    { name: 'read', title: 'Read foo.ts', input: '/home/src/foo.ts' },
    { name: 'write', title: 'Write bar.ts', input: '/home/src/bar.ts' },
    { name: 'edit', title: 'Edit baz.ts', input: '/home/src/baz.ts' },
    { name: 'mcp__docs__search', title: 'docs · search', input: '{\n  "query": "notes"\n}' },
  ]);
});

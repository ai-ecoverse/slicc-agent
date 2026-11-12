import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

function query(steps) {
  return steps.map((step) => `step=${encodeURIComponent(JSON.stringify(step))}`).join('&');
}

test("single tool cards get participle titles, or the trusted call's cleaned intent, while input stays the raw command or path", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const steps = [
    { tool: { name: 'bash', args: { command: 'git status -sb' } } },
    {
      tool: {
        name: 'bash',
        args: { command: 'cd /tmp; rm -rf stage && FOO=1 mkdir -p stage | sudo tee log' },
      },
    },
    { tool: { name: 'bash', args: { command: 'a; b; c; d' } } },
    { tool: { name: 'bash', args: { command: '"$X" <<EOF' } } },
    { tool: { name: 'read', args: { path: '/home/src/foo.ts' } } },
    { tool: { name: 'write', args: { path: '/home/src/bar.ts', content: 'x' } } },
    {
      tool: {
        name: 'edit',
        args: { path: '/home/src/baz.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      },
    },
    { tool: { name: 'mcp__docs__search', args: { query: 'notes' } } },
    {
      tool: {
        name: 'bash',
        args: { intent: '  "Backing up   the access list."  ', command: 'cp acl.json acl.bak' },
      },
    },
    {
      tool: {
        name: 'bash',
        args: {
          intent: 'Using token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          command: 'gh auth status',
        },
      },
    },
    { tool: { name: 'bash', args: { intent: ' ', command: 'ls' } } },
    { tool: { name: 'codemode', args: { intent: 'Counting the open issues', code: 'return 1;' } } },
    { tool: { name: 'codemode', args: { code: 'return 2;' } } },
    { tool: { name: 'read', args: { intent: 'Reading the docs', path: '/home/a.md' } } },
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
    { name: 'bash', title: 'Running git', input: 'git status -sb' },
    {
      name: 'bash',
      title: 'Running cd, rm, mkdir and more',
      input: 'cd /tmp; rm -rf stage && FOO=1 mkdir -p stage | sudo tee log',
    },
    { name: 'bash', title: 'Running a, b, c and more', input: 'a; b; c; d' },
    { name: 'bash', title: 'Running a command', input: '"$X" <<EOF' },
    { name: 'read', title: 'Reading foo.ts', input: '/home/src/foo.ts' },
    { name: 'write', title: 'Writing bar.ts', input: '/home/src/bar.ts' },
    { name: 'edit', title: 'Editing baz.ts', input: '/home/src/baz.ts' },
    {
      name: 'mcp__docs__search',
      title: 'Calling docs · search',
      input: '{\n  "query": "notes"\n}',
    },
    { name: 'bash', title: 'Backing up the access list', input: 'cp acl.json acl.bak' },
    { name: 'bash', title: 'Using token [redacted]', input: 'gh auth status' },
    { name: 'bash', title: 'Running ls', input: 'ls' },
    {
      name: 'codemode',
      title: 'Counting the open issues',
      input: '{\n  "code": "return 1;"\n}',
    },
    { name: 'codemode', title: 'Running code', input: '{\n  "code": "return 2;"\n}' },
    { name: 'read', title: 'Reading a.md', input: '/home/a.md' },
  ]);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch, staged } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const LINKEDIN = `---
name: linkedin
description: Manage a LinkedIn company page — publish posts with consistent brand
  voice, grow engagement, respond to comments, analyze performance, preview profiles,
  and aggregate engagement for the monday dispatcher. Maintains a knowledge base of
  content ideas, audience insights, and brand guidelines. Use when the user wants to
  publish a LinkedIn post, draft LinkedIn content, check LinkedIn comments, respond
  to engagement, plan content strategy, review brand voice, view a LinkedIn profile,
  or manage a company page. Activate on mentions of LinkedIn, LinkedIn post, company
  page, social media, content calendar, engagement, brand voice, or audience growth.
allowed-tools: bash
---
Manage the company page.`;
const DESCRIPTION = LINKEDIN.split('description: ')[1]
  .split('\nallowed-tools:')[0]
  .split('\n')
  .map((line) => line.trim())
  .join(' ');

test('boot lists the full bundled LinkedIn description without warn licks', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await staged(
    page,
    'the LinkedIn skill on boot',
    async (skill) => {
      let dir = await navigator.storage.getDirectory();
      for (const part of ['usr', 'share', 'skills', 'linkedin'])
        dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (
        await dir.getFileHandle('SKILL.md', { create: true })
      ).createWritable();
      await writable.write(skill);
      await writable.close();
      await import('/dist-test/page.js');
      const { bootKernel } = await import('/kernel.js');
      const kernel = await bootKernel();
      const owner = await startTracked({
        worker: () => new Worker('/dist-test/main-worker.js?answer=Done.', { type: 'module' }),
        kernel: { connect: () => kernel.connect() },
      });
      const connection = await owner.connect();
      const agent = createAgentModel(connection, { storage: localStorage }).agent;
      await agent.ready();
      await when(
        [connection.commands],
        () => connection.commands.value.some((command) => command.name === 'skill:linkedin'),
        'the LinkedIn skill'
      );
      const result = {
        skill: connection.commands.value.find((command) => command.name === 'skill:linkedin'),
        warnings: agent
          .messages()
          .filter((message) => message.role === 'lick' && message.severity === 'warn'),
      };
      await owner.release();
      return result;
    },
    LINKEDIN
  );
  assert.equal(seen.skill.description, DESCRIPTION);
  assert.deepEqual(seen.warnings, []);
});

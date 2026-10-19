import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

test('Settings shows Bedrock’s region as a picker of its regions, on the region the account stored', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const seen = await page.evaluate(async () => {
    const until = async (check, tries = 500) => {
      for (let n = 0; n < tries && !check(); n++) await new Promise((r) => setTimeout(r, 20));
      return check();
    };
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
    await import('/node_modules/@ai-ecoverse/slicc-spectrum/dist/slicc-ui.js');
    const { bootKernel } = await import('/kernel.js');
    await import('/dist-test/page.js');
    const kernel = await bootKernel();
    const owner = await startAgent({
      worker: () => new Worker('/dist-test/main-worker.js?bedrock&vault', { type: 'module' }),
      kernel: { connect: () => kernel.connect() },
    });
    const model = createAgentModel(await owner.connect(), { storage: localStorage });
    await model.agent.ready();
    const bedrock = () =>
      model.settings.accounts().find((account) => account.id === 'amazon-bedrock');
    await until(() => bedrock());
    await model.settings.connect('amazon-bedrock', undefined, { region: 'eu-central-1' });
    await until(() => bedrock()?.fields?.[0]?.value === 'eu-central-1');
    const settings = document.createElement('slicc-settings');
    settings.model = model;
    document.body.append(settings);
    await until(() =>
      find(settings.shadowRoot, '.account[data-id="amazon-bedrock"] [data-action="connect"]')
    );
    find(settings.shadowRoot, '.account[data-id="amazon-bedrock"] [data-action="connect"]').click();
    await until(() => find(settings.shadowRoot, 'sp-picker[data-account-field="region"]'));
    const picker = find(settings.shadowRoot, 'sp-picker[data-account-field="region"]');
    await picker.updateComplete;
    const items = [...picker.querySelectorAll('sp-menu-item')].map((item) => [
      item.value,
      item.textContent.trim(),
    ]);
    const result = { value: picker.value, items, stored: bedrock().fields[0].value };
    await owner.release();
    return result;
  });
  assert.equal(seen.stored, 'eu-central-1');
  assert.equal(seen.value, 'eu-central-1');
  assert.equal(seen.items.length, 21);
  assert.deepEqual(
    seen.items.find(([value]) => value === 'eu-central-1'),
    ['eu-central-1', 'Europe (Frankfurt), eu-central-1']
  );
  assert.ok(seen.items.some(([value]) => value === 'us-west-2'));
});

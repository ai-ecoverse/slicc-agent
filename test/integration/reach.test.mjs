import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { run } from '../../scripts/reach.mjs';
import { LISTINGS } from '../../src/providers.ts';
import { sliccProviders } from '../../src/settings.ts';

const scratch = mkdtempSync(join(tmpdir(), 'reach-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const answering = (dead) => async (url, init) => {
  const host = new URL(url).host;
  if (host === dead) throw new TypeError('fetch failed');
  const wildcard = host === 'api.x.ai';
  return new Response(init.method === 'OPTIONS' ? null : '{}', {
    status: init.method === 'OPTIONS' ? 204 : 401,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': wildcard
        ? '*'
        : (init.headers['access-control-request-headers'] ?? '*, authorization'),
    },
  });
};

test('a provider that gives no answer three runs in a row turns into a disagreement, and one relying on Authorization under a bare * is listed without failing', async () => {
  const providers = sliccProviders().filter((provider) =>
    ['groq', 'xai', 'mistral'].includes(provider.id)
  );
  const history = join(scratch, 'history.json');
  const report = join(scratch, 'report.json');
  const lines = [];
  const once = () =>
    run({
      providers,
      listings: LISTINGS,
      fetcher: answering('api.mistral.ai'),
      history,
      report,
      log: (line) => lines.push(line),
    });
  const first = await once();
  assert.deepEqual(first.unknown, { mistral: 1 });
  assert.deepEqual(first.disagreeing, []);
  assert.deepEqual(first.wildcard, ['xai']);
  assert.ok(lines.includes('reach: xai direct (wildcard auth)'));
  assert.ok(lines.includes('reach: mistral unknown (1 runs in a row)'));
  await once();
  lines.length = 0;
  const third = await once();
  assert.deepEqual(JSON.parse(readFileSync(history, 'utf8')), { unknown: { mistral: 3 } });
  assert.deepEqual(
    third.disagreeing.map((row) => row.id),
    ['mistral']
  );
  assert.match(
    lines.at(-1),
    /^reach: PASS 3 providers checked, 1 disagree with the listings: mistral gave no answer 3 runs in a row; 1 rely on Authorization under a bare Access-Control-Allow-Headers: \* \(xai\)$/
  );
  assert.deepEqual(
    JSON.parse(readFileSync(report, 'utf8')).disagreeing.map((row) => row.id),
    ['mistral']
  );
  const back = await run({
    providers,
    listings: LISTINGS,
    fetcher: answering(''),
    history,
    report,
    log: () => undefined,
  });
  assert.deepEqual(back.unknown, {});
  assert.deepEqual(back.disagreeing, []);
  assert.deepEqual(JSON.parse(readFileSync(history, 'utf8')), { unknown: {} });
});

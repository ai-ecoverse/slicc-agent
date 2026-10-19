import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isMain } from './main.mjs';

export const ORIGIN = 'https://seven.sliccy.ai';
const SIMPLE = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-length',
  'host',
  'user-agent',
]);
const STRIPPED = 'x-stainless-';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'POST']);
const TIMEOUT_MS = 15_000;

const ENV = {
  AWS_REGION: 'us-west-2',
  AZURE_OPENAI_RESOURCE_NAME: 'example',
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_GATEWAY_ID: 'seven-reach',
};

const CLASSIFY = {
  state: { lick: 'reach' },
  questions: {
    triage: {
      type: 'choice',
      instructions: 'Reach?',
      criteria: { act: 'act on it', ignore: 'ignore it' },
    },
  },
};

const ADOBE_CONFIG = {
  clientId: 'reach',
  scopes: 'openid',
  imsEnvironment: 'prod',
  models: [
    { id: 'reach-anthropic', name: 'Reach Anthropic' },
    { id: 'reach-openai', name: 'Reach OpenAI', api: 'openai' },
  ],
};

export function needed(names) {
  return [
    ...new Set(
      names
        .map((name) => name.toLowerCase())
        .filter((name) => !SIMPLE.has(name) && !name.startsWith(STRIPPED) && !name.startsWith(':'))
    ),
  ].sort();
}

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export function allows(answer, method, names) {
  if (!answer || answer.status < 200 || answer.status > 299) return false;
  const origin = answer.headers['access-control-allow-origin'];
  if (origin !== '*' && origin !== ORIGIN) return false;
  const methods = list(answer.headers['access-control-allow-methods']);
  if (
    !SAFE_METHODS.has(method) &&
    !methods.includes('*') &&
    !methods.includes(method.toLowerCase())
  )
    return false;
  const headers = list(answer.headers['access-control-allow-headers']);
  return headers.includes('*') || names.every((name) => headers.includes(name));
}

export function wildcardAuth(answer, names) {
  const headers = list(answer?.headers['access-control-allow-headers']);
  return (
    names.includes('authorization') && headers.includes('*') && !headers.includes('authorization')
  );
}

export const STREAK = 3;

export function streaks(rows, previous = {}) {
  return Object.fromEntries(
    rows
      .filter((row) => row.verdict === 'unknown')
      .map((row) => [row.id, (previous[row.id] ?? 0) + 1])
  );
}

export function shown(row) {
  return row.wildcard && row.verdict === 'direct' ? 'direct (wildcard auth)' : row.verdict;
}

export function judge(results) {
  if (!results.length) return 'unprobed';
  if (results.some((result) => result.answer && !result.allowed)) return 'cors-free';
  if (results.every((result) => result.allowed)) return 'direct';
  return 'unknown';
}

export async function preflight(request, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(request.url, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': request.method,
        ...(request.names.length
          ? { 'access-control-request-headers': request.names.join(',') }
          : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers: Object.fromEntries(response.headers) };
  } catch {
    return null;
  }
}

const dummy = (name) =>
  name === 'authorization'
    ? 'Bearer reach-0000'
    : name === 'content-type'
      ? 'application/json'
      : 'reach-0000';

export async function answered(request, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(request.url, {
      method: request.method,
      headers: {
        origin: ORIGIN,
        ...Object.fromEntries(request.names.map((name) => [name, dummy(name)])),
      },
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: '{}' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, headers: Object.fromEntries(response.headers) };
  } catch {
    return null;
  }
}

export function readable(answer) {
  const origin = answer?.headers['access-control-allow-origin'];
  return origin === '*' || origin === ORIGIN;
}

function canned(url) {
  const path = new URL(url).pathname;
  if (path.endsWith('/v1/config')) return Response.json(ADOBE_CONFIG);
  return Response.json({ error: { message: 'reach' } }, { status: 401 });
}

export async function captured(providers) {
  const { createModels } = await import('@earendil-works/pi-ai/models');
  const sent = [];
  const native = globalThis.fetch;
  const handlers = createRequire(import.meta.url)('@smithy/node-http-handler');
  const originals = [handlers.NodeHttpHandler, handlers.NodeHttp2Handler].map((handler) => [
    handler.prototype,
    handler.prototype.handle,
  ]);
  for (const [prototype] of originals)
    prototype.handle = async (request) => {
      const url = `${request.protocol}//${request.hostname}${request.path}`;
      sent.push({ url, method: request.method, headers: Object.keys(request.headers) });
      throw new Error('reach captures this request');
    };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, method: request.method, headers: [...request.headers.keys()] });
    return canned(request.url);
  };
  try {
    const credentials = {
      read: async () => ({ type: 'api_key', key: 'reach-0000', env: ENV }),
      list: async () => providers.map((provider) => ({ providerId: provider.id, type: 'api_key' })),
      modify: async () => undefined,
      delete: async () => undefined,
    };
    const models = createModels({ credentials });
    for (const provider of providers) models.setProvider(provider);
    await models
      .refresh({ providers: providers.map((provider) => provider.id) })
      .catch(() => undefined);
    const discovered = [...sent];
    const requests = new Map();
    const { adobeUsage } = await import('../src/adobe.ts');
    for (const provider of providers) {
      const own = discovered
        .filter((entry) => provider.baseUrl && entry.url.startsWith(provider.baseUrl))
        .map((entry) => ({ url: entry.url, method: entry.method, names: needed(entry.headers) }));
      sent.length = 0;
      if (provider.id === 'adobe')
        await adobeUsage('reach-0000', { endpoint: provider.baseUrl, identity: provider.headers });
      const classifiers = new Map(
        (provider.getAllModels?.() ?? [])
          .filter((model) => model.type === 'classifier')
          .map((model) => [model.api, model])
      );
      for (const model of classifiers.values())
        await models.classify(model, CLASSIFY).catch(() => undefined);
      for (const entry of sent)
        own.push({ url: entry.url, method: entry.method, names: needed(entry.headers) });
      const byApi = new Map(models.getModels(provider.id).map((model) => [model.api, model]));
      for (const model of byApi.values()) {
        sent.length = 0;
        const stream = models.streamSimple(
          model,
          { messages: [{ role: 'user', content: 'reach', timestamp: 0 }] },
          { maxRetries: 0 }
        );
        for await (const _event of stream);
        const request = sent.find((entry) => entry.method !== 'GET') ?? sent[0];
        if (request)
          own.push({ url: request.url, method: request.method, names: needed(request.headers) });
      }
      requests.set(provider.id, unique(own));
    }
    return requests;
  } finally {
    globalThis.fetch = native;
    for (const [prototype, handle] of originals) prototype.handle = handle;
  }
}

export async function reach(providers, listings, fetcher) {
  const requests = await captured(providers);
  const rows = [];
  for (const provider of providers) {
    const results = [];
    for (const request of requests.get(provider.id) ?? []) {
      const answer = await preflight(request, fetcher);
      const passed = allows(answer, request.method, request.names);
      const reply = passed ? await answered(request, fetcher) : null;
      results.push({
        ...request,
        answer: passed ? reply : answer,
        allowed: passed && readable(reply),
        wildcard: passed && wildcardAuth(answer, request.names),
      });
    }
    const verdict = judge(results);
    const listed = listings.get(provider.id)?.corsFree ? 'cors-free' : 'direct';
    const wildcard = results.some((result) => result.wildcard);
    rows.push({ id: provider.id, verdict, listed, wildcard, results });
  }
  return rows;
}

export const disagreeing = (rows, unknown = {}) =>
  rows.filter((row) =>
    row.verdict === 'unknown' ? (unknown[row.id] ?? 0) >= STREAK : row.verdict !== row.listed
  );

export function unique(requests) {
  const seen = new Set();
  return requests.filter((request) => {
    const key = `${request.method} ${request.url.split('?')[0]} ${request.names.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const history = (path) => {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed.unknown === 'object' ? parsed.unknown : {};
  } catch {
    return {};
  }
};

export async function run({
  providers,
  listings,
  fetcher,
  history: past,
  report,
  log = console.log,
}) {
  const rows = await reach(providers, listings, fetcher);
  const unknown = streaks(rows, history(past));
  for (const row of rows)
    log(
      `reach: ${row.id} ${shown(row)}${unknown[row.id] ? ` (${unknown[row.id]} runs in a row)` : ''}`
    );
  const off = disagreeing(rows, unknown);
  const wildcard = rows
    .filter((row) => row.wildcard && row.verdict === 'direct')
    .map((row) => row.id);
  if (past) writeFileSync(past, JSON.stringify({ unknown }));
  if (report)
    writeFileSync(report, JSON.stringify({ rows, disagreeing: off, unknown, wildcard }, null, 2));
  const told = (row) =>
    row.verdict === 'unknown'
      ? `${row.id} gave no answer ${unknown[row.id]} runs in a row`
      : `${row.id} is ${row.verdict}, listed ${row.listed}`;
  log(
    `reach: PASS ${rows.length} providers checked, ${off.length} disagree with the listings${off.length ? `: ${off.map(told).join('; ')}` : ''}; ${wildcard.length} rely on Authorization under a bare Access-Control-Allow-Headers: *${wildcard.length ? ` (${wildcard.join(', ')})` : ''}`
  );
  return { rows, disagreeing: off, unknown, wildcard };
}

if (isMain(import.meta.url)) {
  const { sliccProviders } = await import('../src/settings.ts');
  const { LISTINGS } = await import('../src/providers.ts');
  await run({
    providers: sliccProviders(),
    listings: LISTINGS,
    history: process.env.REACH_HISTORY,
    report: process.env.REACH_REPORT,
  });
}

import { compile } from '@ai-ecoverse/slicc-scrub';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FOUND = /fnox_proxy_[A-Za-z0-9_]+/g;
const KERNEL = /^(\d{1,5})\.kernel\.localhost$/;

class Refused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const strip = ({ value: _value, url: _url, refresh: _refresh, ...shown }) => shown;
const templated = (base, url) => {
  const source = base
    .replace(/\/+$/, '')
    .split(/(\{[^}]+\})/)
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? '[^./]+' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    )
    .join('');
  return new RegExp(`^${source}(?:[/?#]|$)`).test(url.href);
};
const under = (base, url) => {
  if (base.includes('{')) return templated(base, url);
  const own = new URL(base);
  const path = own.pathname.replace(/\/+$/, '');
  return (
    own.protocol === url.protocol &&
    own.host === url.host &&
    (url.pathname === path || url.pathname.startsWith(`${path}/`) || path === '')
  );
};
const loopback = (url) => {
  const port = Number(KERNEL.exec(url.hostname)?.[1] ?? 0);
  return url.protocol === 'http:' && port > 0 && port !== 9222;
};

export function serveVault(port, values, version = 1, options = {}) {
  const records = (options.records ?? []).map((record) => ({ state: 'ready', ...record }));
  const builtIn = options.models ?? [];
  let current = version;
  const secretsOf = () =>
    [...values, ...records].map(({ name, value, placeholder }) => ({ name, value, placeholder }));
  let scrubber = compile(secretsOf(), { version: current });
  const rebuild = () => {
    current += 1;
    scrubber = compile(secretsOf(), { version: current });
  };
  const registered = { model: [], mcp: [] };
  const streams = new Map();
  const log = [];
  const queue = [];
  const failures = [];
  const sent = [];
  let paused = false;
  const head = (request) => [request.url, ...request.headers.map(([, value]) => value)];
  const fill = (text, owns, reaches, url) => {
    let out = text;
    for (const placeholder of new Set(text.match(FOUND) ?? [])) {
      const secret = values.find((item) => item.placeholder === placeholder);
      if (secret)
        throw new Refused(
          'EACCES',
          `${secret.name} is a secret; secrets are never sent to model or MCP endpoints`
        );
      const record = records.find((item) => item.placeholder === placeholder);
      if (!record) continue;
      if (!owns(record))
        throw new Refused('EACCES', `${record.name} isn't a credential of this request`);
      if (!reaches) throw new Refused('EACCES', `${record.name} is sent only to its own endpoints`);
      out = out.split(placeholder).join(url ? encodeURIComponent(record.value) : record.value);
    }
    return out;
  };
  const prepare = (request, owns, reaches, http) => {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !http)
      throw new Refused('EACCES', 'model and MCP requests go out over https only');
    if (head(request).some((text) => scrubber.text(text).hits.length))
      throw new Refused('EACCES', 'the request head carries a value; send its placeholder instead');
    const body =
      request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? scrubber.text(request.body).text
          : scrubber.bytes(request.body).bytes;
    const ready = {
      method: request.method,
      url: fill(request.url, owns, reaches, true),
      headers: request.headers.map(([name, value]) => [name, fill(value, owns, reaches, false)]),
      ...(body === undefined ? {} : { body }),
    };
    sent.push(ready);
    return { request: ready, hits: [], version: current };
  };
  const model = (message) => {
    const present = new Set(head(message.request).join(' ').match(FOUND) ?? []);
    const inferred = records.filter(
      (item) => item.kind === 'model' && present.has(item.placeholder)
    );
    const provider = message.provider ?? (inferred.length === 1 ? inferred[0].provider : null);
    const url = new URL(message.request.url);
    const reaches =
      provider !== null &&
      [...builtIn, ...registered.model].some(
        (entry) => entry.provider === provider && under(entry.url, url)
      );
    return prepare(
      message.request,
      (record) => record.kind === 'model' && record.provider === provider,
      reaches,
      false
    );
  };
  const mcp = (message) => {
    const url = new URL(message.request.url);
    const entries = registered.mcp.filter((entry) => entry.server === message.server);
    const entry = entries.find((item) => item.tokenUrl === url.href || under(item.url, url));
    const names = new Set(entries.flatMap((item) => item.names ?? []));
    return prepare(
      message.request,
      (record) =>
        record.kind === 'mcp' && (record.server === message.server || names.has(record.name)),
      Boolean(entry),
      Boolean(entry) && loopback(url) && loopback(new URL(entry.url))
    );
  };
  const grant = (message) => {
    const known = registered.mcp.find(
      (entry) => entry.server === message.server && entry.tokenUrl === message.oauth?.tokenUrl
    );
    if (!known)
      throw new Refused(
        'EACCES',
        `${message.oauth?.tokenUrl} isn't the registered tokenUrl of ${message.server}`
      );
    if (!message.oauth?.clientId) throw new Refused('EINVAL', 'oauth must have a clientId');
    const raw =
      typeof message.response === 'string' ? message.response : decoder.decode(message.response);
    const parsed = JSON.parse(raw);
    if (typeof parsed.token_type !== 'string' || parsed.token_type.toLowerCase() !== 'bearer')
      throw new Refused('EACCES', 'the IdP returned a token_type other than Bearer');
    if (parsed.expires_in !== undefined && !Number.isInteger(parsed.expires_in))
      throw new Refused('EACCES', 'the IdP returned an invalid expires_in');
    const base = `${message.server.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_ACCESS_TOKEN`;
    const access = {
      kind: 'mcp',
      name: base,
      placeholder: `fnox_proxy_${message.server}_access`,
      value: parsed.access_token,
      server: message.server,
      state: 'ready',
      ...(parsed.refresh_token ? { refresh: true } : {}),
    };
    const sealed = [access];
    if (parsed.refresh_token)
      sealed.push({
        kind: 'grant',
        name: `${base}_GRANT`,
        placeholder: `fnox_proxy_${message.server}_grant`,
        value: parsed.refresh_token,
      });
    for (const record of sealed) {
      const at = records.findIndex(
        (item) => item.kind === record.kind && item.name === record.name
      );
      if (at >= 0) records.splice(at, 1, record);
      else records.push(record);
    }
    rebuild();
    const shown = {
      ...(parsed.token_type ? { token_type: parsed.token_type } : {}),
      ...(typeof parsed.expires_in === 'number' ? { expires_in: parsed.expires_in } : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      access_token: access.placeholder,
      ...(parsed.refresh_token ? { refresh_token: sealed[1].placeholder } : {}),
    };
    const text = JSON.stringify(shown);
    return {
      response: typeof message.response === 'string' ? text : encoder.encode(text),
      records: sealed.map(({ kind, name, placeholder }) => ({ kind, name, placeholder })),
    };
  };
  const refresh = async (message) => {
    const found = records.filter(
      (item) =>
        item.refresh &&
        (message.server
          ? item.kind === 'mcp' && item.server === message.server
          : item.kind === 'model' && item.provider === message.provider)
    );
    if (!found.length)
      throw new Refused(
        'ENOENT',
        `${message.server ?? message.provider} has no refreshable credential`
      );
    for (const record of found) {
      if (options.refreshed) {
        const grant = records.find(
          (item) => item.kind === 'grant' && item.name === `${record.name}_GRANT`
        );
        const next = await options.refreshed(record, grant);
        if (!next) throw new Refused('EACCES', 'refresh failed: invalid_grant');
        if (typeof next === 'string') record.value = next;
        else {
          record.value = next.access;
          if (grant && next.refresh) grant.value = next.refresh;
        }
      }
      record.state = 'ready';
    }
    rebuild();
    return { state: 'refreshed' };
  };
  const endpoints = (message) => {
    for (const entry of message.model ?? [])
      registered.model.push(typeof entry === 'string' ? { provider: null, url: entry } : entry);
    for (const entry of message.mcp ?? []) {
      const given = typeof entry === 'string' ? { server: entry, url: entry } : entry;
      const first = registered.mcp.find((item) => item.server === given.server && item.tokenUrl);
      registered.mcp.push(first ? { ...given, tokenUrl: first.tokenUrl } : given);
    }
    return { ok: true };
  };
  const ops = {
    redact: (message) => {
      const hits = [];
      const texts = message.texts.map((text) => {
        const done = typeof text === 'string' ? scrubber.text(text) : scrubber.bytes(text);
        hits.push(...done.hits);
        return typeof text === 'string' ? done.text : done.bytes;
      });
      return { texts, hits, version: current };
    },
    redactStream: (message) => {
      streams.set(message.stream, scrubber.stream());
      return { stream: message.stream, idleMs: scrubber.idleMs, version: current };
    },
    push: (message) => ({ chunk: stream(message).push(message.chunk) }),
    idle: (message) => ({ chunk: stream(message).idle() }),
    end: (message) => {
      const open = stream(message);
      const chunk = open.end();
      streams.delete(message.stream);
      return { chunk, hits: open.hits };
    },
    drop: (message) => {
      streams.delete(message.stream);
      return {};
    },
    endpoints,
    model,
    mcp,
    records: () => ({
      records: records.filter((item) => item.kind === 'model' || item.kind === 'mcp').map(strip),
    }),
    grant,
    refresh,
  };
  const stream = (message) => {
    const found = streams.get(message.stream);
    if (!found) throw new Refused('ENOENT', `no stream ${message.stream}`);
    return found;
  };
  let chain = Promise.resolve();
  const answerOne = async (message) => {
    const { id, op } = message;
    try {
      if (message.v !== 1) throw new Refused('EINVAL', 'this vault speaks protocol 1');
      const failing = failures.findIndex((item) => item.op === op);
      if (failing >= 0) {
        const [failure] = failures.splice(failing, 1);
        throw new Refused(failure.code, failure.message);
      }
      const handler = ops[op];
      if (!handler) throw new Refused('ENOTSUP', `this vault has no op ${op}`);
      port.postMessage({ v: 1, id, op, ...(await handler(message)) });
    } catch (error) {
      port.postMessage({
        v: 1,
        id,
        error: { code: error.code ?? 'EINVAL', message: error.message },
      });
    }
  };
  const answer = (message) => {
    chain = chain.then(() => answerOne(message));
  };
  port.onmessage = ({ data }) => {
    log.push(data);
    if (paused) queue.push(data);
    else answer(data);
  };
  port.start?.();
  return {
    log,
    sent,
    records,
    registered,
    pair: { needed: values.length + records.length > 0, version },
    get version() {
      return current;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const message of queue.splice(0)) answer(message);
    },
    publish(pair) {
      port.postMessage({ scrub: pair });
    },
    fail(op, code, message = `${op} failed`) {
      failures.push({ op, code, message });
    },
    expire(name) {
      const record = records.find((item) => item.name === name);
      if (record) record.state = 'expired';
    },
    add(record) {
      records.push({ state: 'ready', ...record });
      rebuild();
    },
    remove(name) {
      const at = records.findIndex((item) => item.name === name);
      if (at >= 0) records.splice(at, 1);
      rebuild();
    },
    welcome(status) {
      port.postMessage({ v: 1, op: 'welcome', role: 'agent', status });
    },
  };
}

export function fakeVault(values, version = 1, options = {}) {
  const channel = new MessageChannel();
  return Object.assign(serveVault(channel.port2, values, version, options), {
    port: channel.port1,
  });
}

export const MAX_SOURCE = 512 * 1024;
export const MAX_AGENTS = 1000;
export const MAX_ITEMS = 4096;
export const MAX_SCHEMA = 64 * 1024;
export const DEFAULT_CONCURRENCY = 8;

export interface Meta {
  name: string;
  description: string;
}

export interface Config {
  args?: unknown;
  budget: number | null;
  concurrency: number;
}

export function maxConcurrency(cores = globalThis.navigator?.hardwareConcurrency ?? 8): number {
  return Math.min(16, Math.max(8, cores * 4));
}

function skipQuoted(source: string, at: number): number {
  const quote = source[at];
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === quote) return i;
  }
  return source.length;
}

function block(source: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i] as string;
    if (char === '"' || char === "'" || char === '`') i = skipQuoted(source, i);
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start + 1, i);
  }
  return null;
}

function field(text: string, name: string): string | null {
  const found = new RegExp(
    `(?:^|[\\s,{])["']?${name}["']?\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`
  ).exec(text);
  return found ? (found[2] as string) : null;
}

export function parseMeta(source: string): Meta {
  if (source.length > MAX_SOURCE) throw new Error('a workflow is at most 512 KiB');
  const found = /^\s*export\s+const\s+meta\s*=\s*\{/.exec(source.replace(/^#![^\n]*/, ''));
  if (!found) throw new Error('a workflow starts with export const meta = { name, description }');
  const offset = source.length - source.replace(/^#![^\n]*/, '').length;
  const text = block(source, offset + found[0].length - 1);
  if (text === null) throw new Error('export const meta has no closing brace');
  const name = field(text, 'name');
  const description = field(text, 'description');
  if (!name?.trim()) throw new Error('meta.name must be a non-empty string');
  if (!description?.trim()) throw new Error('meta.description must be a non-empty string');
  return { name, description };
}

export function stripExports(source: string): string {
  return source
    .replace(/^#![^\n]*/, '')
    .replace(/\bexport\s+(const|let|var|function|async\s+function|class)\b/g, '$1');
}

export const PRELUDE = `
class WorkflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkflowError';
  }
}
const __RealDate = globalThis.Date;
const __RealMath = globalThis.Math;
const __banned = (what) => () => {
  throw new WorkflowError(what + ' is not allowed in a workflow; pass time or randomness in args');
};
const Date = function Date(...given) {
  if (new.target === undefined) __banned('Date()')();
  if (given.length === 0) __banned('new Date()')();
  return new __RealDate(...given);
};
Date.prototype = __RealDate.prototype;
Date.UTC = __RealDate.UTC;
Date.parse = __RealDate.parse;
Date.now = __banned('Date.now()');
const Math = {};
for (const key of Object.getOwnPropertyNames(__RealMath)) Math[key] = __RealMath[key];
Math.random = __banned('Math.random()');
const crypto = { getRandomValues: __banned('crypto.getRandomValues()'), randomUUID: __banned('crypto.randomUUID()') };
const performance = { now: __banned('performance.now()') };
const setTimeout = __banned('setTimeout()');
const setInterval = __banned('setInterval()');
const args = __WF.args;
const __OPTIONS = ['label', 'phase', 'schema', 'model', 'effort', 'agentType', 'isolation'];
let __started = 0;
let __spent = 0;
let __phase = null;
let __active = 0;
const __waiting = [];
const __acquire = async () => {
  if (__active < __WF.concurrency) {
    __active++;
    return;
  }
  await new Promise((resume) => __waiting.push(resume));
};
const __release = () => {
  const next = __waiting.shift();
  if (next) next();
  else __active--;
};
const __text = (values) =>
  values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
const __note = (kind, text) => {
  __notify({ kind, text }).then(undefined, () => undefined);
};
const __gate = () => {
  if (__WF.budget !== null && __spent >= __WF.budget)
    throw new WorkflowError('agent(): the budget of ' + __WF.budget + ' output tokens is spent');
};
const __failed = (error) => {
  __note('log', '[error] ' + (error && error.message ? error.message : String(error)));
  return null;
};
const console = {
  log: (...values) => __note('log', __text(values)),
  info: (...values) => __note('log', __text(values)),
  debug: (...values) => __note('log', __text(values)),
  warn: (...values) => __note('log', '[warn] ' + __text(values)),
  error: (...values) => __note('log', '[error] ' + __text(values)),
};
const budget = Object.freeze({
  total: __WF.budget,
  spent: () => __spent,
  remaining: () => (__WF.budget === null ? Infinity : Math.max(0, __WF.budget - __spent)),
});
function phase(title) {
  __phase = String(title);
  __note('phase', __phase);
}
function log(message) {
  __note('log', String(message));
}
function workflow() {
  throw new WorkflowError('workflow(): nested workflows are not supported in SLICC');
}
async function agent(prompt, options) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new WorkflowError('agent() needs a prompt string');
  const given = options === undefined || options === null ? {} : options;
  if (typeof given !== 'object' || Array.isArray(given)) throw new WorkflowError('agent(): options must be an object');
  for (const key of Object.keys(given))
    if (!__OPTIONS.includes(key)) throw new WorkflowError('agent(): unknown option ' + key);
  if (given.isolation !== undefined) throw new WorkflowError('agent(): isolation is not supported in SLICC');
  if (__started >= ${MAX_AGENTS}) throw new WorkflowError('agent(): a workflow starts at most ${MAX_AGENTS} agents');
  __gate();
  __started++;
  await __acquire();
  try {
    __gate();
    const call = { ...given, prompt };
    if (call.phase === undefined && __phase !== null) call.phase = __phase;
    try {
      const answer = await __agent(call);
      __spent += answer.outputTokens;
      return answer.value;
    } catch (error) {
      __spent += error && typeof error.outputTokens === 'number' ? error.outputTokens : 0;
      throw error;
    }
  } finally {
    __release();
  }
}
async function parallel(thunks) {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== 'function'))
    throw new WorkflowError('parallel() expects an array of functions');
  if (thunks.length > ${MAX_ITEMS}) throw new WorkflowError('parallel(): at most ${MAX_ITEMS} items per call');
  return Promise.all(
    thunks.map(async (thunk) => {
      try {
        return await thunk();
      } catch (error) {
        return __failed(error);
      }
    })
  );
}
async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new WorkflowError('pipeline() expects an array as its first argument');
  if (items.length > ${MAX_ITEMS}) throw new WorkflowError('pipeline(): at most ${MAX_ITEMS} items per call');
  if (stages.some((stage) => typeof stage !== 'function')) throw new WorkflowError('pipeline(): every stage must be a function');
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch (error) {
          return __failed(error);
        }
        if (value === null) return null;
      }
      return value;
    })
  );
}
`;

export function buildCode(source: string, config: Config): string {
  return [
    '{',
    'const tools = undefined;',
    `const __WF = ${JSON.stringify(config)};`,
    PRELUDE,
    'const __main = async () => {',
    stripExports(source),
    '};',
    'const __value = await __main();',
    'return __value === undefined ? null : __value;',
    '}',
  ].join('\n');
}

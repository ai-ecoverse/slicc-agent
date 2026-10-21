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
const RealDate = globalThis.Date;
const RealMath = globalThis.Math;
const banned = (what) => () => {
  throw new WorkflowError(what + ' is not allowed in a workflow; pass time or randomness in args');
};
const Date = function Date(...given) {
  if (new.target === undefined) banned('Date()')();
  if (given.length === 0) banned('new Date()')();
  return new RealDate(...given);
};
Date.prototype = RealDate.prototype;
Date.UTC = RealDate.UTC;
Date.parse = RealDate.parse;
Date.now = banned('Date.now()');
Object.freeze(Date);
const Math = {};
for (const key of Object.getOwnPropertyNames(RealMath)) Math[key] = RealMath[key];
Math.random = banned('Math.random()');
Object.freeze(Math);
const crypto = Object.freeze({
  getRandomValues: banned('crypto.getRandomValues()'),
  randomUUID: banned('crypto.randomUUID()'),
});
const performance = Object.freeze({ now: banned('performance.now()') });
const setTimeout = banned('setTimeout()');
const setInterval = banned('setInterval()');
const OPTIONS = ['label', 'phase', 'schema', 'model', 'effort', 'agentType', 'isolation'];
const lanes = config.concurrency;
let started = 0;
let spent = 0;
let current = null;
let active = 0;
const waiting = [];
const acquire = async () => {
  if (active < lanes) {
    active++;
    return;
  }
  await new Promise((resume) => waiting.push(resume));
};
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else active--;
};
const textOf = (values) =>
  values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
const note = (kind, text) => {
  tell({ kind, text }).then(undefined, () => undefined);
};
const gate = () => {
  if (config.budget !== null && spent >= config.budget)
    throw new WorkflowError('agent(): the budget of ' + config.budget + ' output tokens is spent');
};
const failed = (error) => {
  note('log', '[error] ' + (error && error.message ? error.message : String(error)));
  return null;
};
const console = Object.freeze({
  log: (...values) => note('log', textOf(values)),
  info: (...values) => note('log', textOf(values)),
  debug: (...values) => note('log', textOf(values)),
  warn: (...values) => note('log', '[warn] ' + textOf(values)),
  error: (...values) => note('log', '[error] ' + textOf(values)),
});
const budget = Object.freeze({
  total: config.budget,
  spent: () => spent,
  remaining: () => (config.budget === null ? Infinity : Math.max(0, config.budget - spent)),
});
function phase(title) {
  current = String(title);
  note('phase', current);
}
function log(message) {
  note('log', String(message));
}
function workflow() {
  throw new WorkflowError('workflow(): nested workflows are not supported in SLICC');
}
async function agent(prompt, options) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new WorkflowError('agent() needs a prompt string');
  const given = options === undefined || options === null ? {} : options;
  if (typeof given !== 'object' || Array.isArray(given)) throw new WorkflowError('agent(): options must be an object');
  for (const key of Object.keys(given))
    if (!OPTIONS.includes(key)) throw new WorkflowError('agent(): unknown option ' + key);
  if (given.isolation !== undefined) throw new WorkflowError('agent(): isolation is not supported in SLICC');
  if (started >= ${MAX_AGENTS}) throw new WorkflowError('agent(): a workflow starts at most ${MAX_AGENTS} agents');
  gate();
  started++;
  await acquire();
  try {
    gate();
    const call = { ...given, prompt };
    if (call.phase === undefined && current !== null) call.phase = current;
    try {
      const answer = await host(call);
      spent += answer.outputTokens;
      return answer.value;
    } catch (error) {
      spent += error && typeof error.outputTokens === 'number' ? error.outputTokens : 0;
      throw error;
    }
  } finally {
    release();
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
        return failed(error);
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
          return failed(error);
        }
        if (value === null) return null;
      }
      return value;
    })
  );
}
return Object.freeze({
  agent, parallel, pipeline, phase, log, workflow, console, budget, args: config.args,
  Date, Math, crypto, performance, setTimeout, setInterval, WorkflowError,
});
`;

export const PUBLIC = [
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'workflow',
  'console',
  'budget',
  'args',
  'Date',
  'Math',
  'crypto',
  'performance',
  'setTimeout',
  'setInterval',
  'WorkflowError',
];

export function buildCode(source: string, config: Config): string {
  return [
    '{',
    `const __api = (function (config, host, tell) {${PRELUDE}})(Object.freeze(${JSON.stringify(config)}), __agent, __notify);`,
    '{',
    'const tools = undefined;',
    'const __agent = undefined;',
    'const __notify = undefined;',
    `const { ${PUBLIC.join(', ')} } = __api;`,
    'const __main = async () => {',
    stripExports(source),
    '};',
    'const __value = await __main();',
    'return __value === undefined ? null : __value;',
    '}',
    '}',
  ].join('\n');
}

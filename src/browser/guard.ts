import { defineExtension, type Extension, hook, ToolTask } from '@earendil-works/pi-durable';
import { FACADE_PORT, kernelHost, ownKernelServer } from '../kernel/loopback.ts';
import { folded, PROTECTED_RULES, type ProtectedMatcher, protectedMatcher } from './origins.ts';
import { commands, MAX_DEPTH, type SimpleCommand, words } from './shell.ts';

export const BROWSER_GUARD = 'slicc-browser-guard';
export const REFUSAL = "SLICC's own pages can't be opened or driven from the browser tools.";
export { FACADE_PORT, ownKernelServer };

const BROWSER = new Set(['playwright-cli', 'curlwright']);
const WEB = new Set(['http:', 'https:', 'ws:', 'wss:']);
const INNER = new Set(PROTECTED_RULES.innerSchemes.map((scheme) => `${scheme}:`));
const SCHEMED = /^[a-z][a-z0-9+.-]*:/i;
const EMBEDDED = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>(){}\\]+/gi;
const RELATIVE = /(?<![:\w/])\/\/[^\s'"`<>(){}\\/]+/g;
const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*|-{1,2}[A-Za-z0-9-]+)=/;
const IPV6 = /\[[0-9a-f]*:/i;
const HOSTLIKE =
  /^[^\s/?#]*(?:\.|%2e|%e3%80%82|%ef%bc%8e|%ef%bd%a1|[\u3002\uff0e\uff61])[^\s/?#]*(?:[/?#]\S*)?$/i;

export interface Candidate {
  url: string;
  lenient: boolean;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function foreignKernel(url: string): boolean {
  let parsed = parse(url);
  for (let depth = 0; parsed && INNER.has(parsed.protocol) && depth < 8; depth++)
    parsed = parse(parsed.href.slice(parsed.protocol.length));
  if (!parsed || !WEB.has(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/\.+$/, '');
  return kernelHost(host) && !ownKernelServer(host);
}

export function forbidden(url: string, matcher: ProtectedMatcher, lenient = false): boolean {
  return matcher.url(url, { readOnly: lenient }) || foreignKernel(url);
}

export function candidates(raw: string): Candidate[] {
  const word = raw.replace(/[\t\n\r]/g, '').replace(/^[\0- ]+|[\0- ]+$/g, '');
  const value = word.replace(PREFIX, '');
  const found = [
    word,
    value,
    ...(value.match(EMBEDDED) ?? []),
    ...(value.match(RELATIVE) ?? []).map((relative) => `https:${relative}`),
  ].map((url) => ({ url, lenient: false }));
  if (!/^[/.~-]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    found.push({
      url: `https://${value}`,
      lenient: !HOSTLIKE.test(value) || (/[[\]]/.test(value) && !IPV6.test(folded(value))),
    });
  if (value.startsWith('//') && value.length > 2)
    found.push({ url: `https:${value}`, lenient: false });
  return found.filter((each) => SCHEMED.test(each.url));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INERT = new Set([
  'head',
  'tail',
  'cat',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'echo',
  'printf',
  'jq',
  'wc',
  'ls',
  'sort',
  'uniq',
  'cut',
  'tr',
]);
const GH = new Set(['issue', 'pr', 'api', 'search']);
const GIT = new Set(['log', 'show', 'grep', 'diff', 'status']);
const EXECUTION_OPTIONS: Record<string, readonly string[]> = {
  rg: ['--pre'],
  sort: ['--compress-program'],
  git: ['--exec-path', '--open-files-in-pager', '--config-env'],
};
const BROWSER_WORD = /\b(?:playwright-cli|curlwright)\b/;

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

function executableOption(name: string, arg: string): boolean {
  const flag = arg.split('=', 1)[0] as string;
  if (flag.startsWith('--') && flag !== '--')
    return ['--output', '--ext-diff', '--textconv', ...(EXECUTION_OPTIONS[name] ?? [])].some(
      (option) => option.startsWith(flag)
    );
  return (name === 'git' && /^-[^-]*[cO]/.test(arg)) || (name === 'sort' && /^-[^-]*o/.test(arg));
}

function dataCommand(simple: SimpleCommand, depth: number, matcher: ProtectedMatcher): boolean {
  if (simple.output || simple.uncertain || depth >= MAX_DEPTH) return false;
  const args = [...simple.words];
  if (args[0] === 'do') args.shift();
  while (ASSIGNMENT.test(args[0] ?? '')) {
    if (protectedArgument([args.shift() as string], matcher)) return false;
  }
  if (/[$`*?[\]]/.test(args[0] ?? '')) return false;
  const executable = args.shift() ?? '';
  if (protectedArgument([executable], matcher)) return false;
  const name = basename(executable);
  if (
    !INERT.has(name) &&
    !(name === 'gh' && GH.has(args[0] ?? '')) &&
    !(name === 'git' && GIT.has(args[0] ?? ''))
  )
    return false;
  if (args.some((arg) => executableOption(name, arg))) return false;
  return simple.scripts.every((script) => {
    const nested = commands(script);
    return nested.length > 0 && nested.every((command) => dataCommand(command, depth + 1, matcher));
  });
}

function classified(simple: SimpleCommand): boolean {
  if (simple.uncertain) return false;
  const first = simple.words[0] as string;
  return (
    BROWSER.has(basename(first)) ||
    first === 'for' ||
    (simple.words.length === 1 && ['do', 'done'].includes(first))
  );
}

function inertText(source: string, matcher: ProtectedMatcher): string {
  const parsed = commands(source);
  const inert = parsed.map((simple) => dataCommand(simple, 0, matcher));
  const known = parsed.every((simple, at) => inert[at] || classified(simple));
  if (!known) return source;
  for (let at = parsed.length - 2; at >= 0; at--)
    if (parsed[at]?.pipe && !inert[at + 1]) inert[at] = false;
  const chars = source.split('');
  for (const [at, simple] of parsed.entries()) {
    if (!inert[at]) continue;
    for (const [start, end] of simple.ranges)
      for (let index = start; index < end; index++) chars[index] = ' ';
  }
  return chars.join('');
}

function protectedArgument(args: string[], matcher: ProtectedMatcher): string | undefined {
  for (const arg of args.flatMap((arg) => words(arg))) {
    for (const { url, lenient } of candidates(arg)) {
      const rule = foreignKernel(url)
        ? 'foreign kernel host or CDP facade'
        : matcher.rule(url, {
            readOnly: lenient && (parse(url) !== undefined || !matcher.mentions(url)),
          });
      if (rule) return `${REFUSAL} Rule: ${rule}; target: ${url}`;
    }
  }
  return undefined;
}

export function refused(command: string, matcher: ProtectedMatcher): string | undefined {
  if (!BROWSER_WORD.test(command) && !words(command).some((word) => BROWSER.has(basename(word))))
    return undefined;
  const remaining = inertText(command, matcher);
  const reason = protectedArgument([remaining], matcher);
  if (reason) return reason;
  if (
    commands(remaining).some(
      (simple) =>
        simple.dynamic &&
        (BROWSER_WORD.test(simple.words.join(' ')) ||
          ['eval', 'source', '.'].includes(simple.words[0] as string))
    )
  )
    return `${REFUSAL} Rule: command too dynamic to check.`;
  return undefined;
}

function commandOf(args: unknown): string {
  const command = (args as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' ? command : '';
}

export function browserGuard(origins: readonly string[]): Extension {
  const matcher = protectedMatcher(origins);
  return defineExtension({
    name: BROWSER_GUARD,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) => {
          const reason =
            call.name === 'bash' ? refused(commandOf(call.arguments), matcher) : undefined;
          return reason ? { block: reason } : undefined;
        },
      }),
    ],
  });
}

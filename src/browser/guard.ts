import { defineExtension, type Extension, hook, ToolTask } from '@earendil-works/pi-durable';
import { FACADE_PORT, kernelHost, ownKernelServer } from '../kernel/loopback.ts';
import { PROTECTED_RULES, type ProtectedMatcher, protectedMatcher } from './origins.ts';
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
    found.push({ url: `https://${value}`, lenient: !HOSTLIKE.test(value) });
  if (value.startsWith('//')) found.push({ url: `https:${value}`, lenient: false });
  return found.filter((each) => SCHEMED.test(each.url));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'xargs']);
const OPTION_VALUE: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  exec: new Set(['-a']),
  xargs: new Set([
    '-a',
    '--arg-file',
    '-E',
    '-I',
    '--replace',
    '-L',
    '--max-lines',
    '-n',
    '--max-args',
    '-P',
    '--max-procs',
    '-s',
    '--max-chars',
  ]),
  time: new Set(['-f', '--format', '-o', '--output']),
  sudo: new Set([
    '-u',
    '--user',
    '-g',
    '--group',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-C',
    '--close-from',
    '-D',
    '--chdir',
    '-R',
    '--chroot',
    '-r',
    '--role',
    '-t',
    '--type',
    '-T',
    '--command-timeout',
  ]),
};
const CONTROL = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', '{', '}']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const DYNAMIC = 'command too dynamic to check';

function basename(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1);
}

function unwrap(args: string[]): boolean {
  const wrapper = basename(args.shift() as string);
  while (args[0]?.startsWith('-')) {
    const option = args.shift() as string;
    if (wrapper === 'command' && /^-[p]*[vV]/.test(option)) return false;
    if (wrapper === 'env' && (option === '-S' || option.startsWith('--split-string'))) {
      args.unshift('eval');
      return true;
    }
    if (option === '--') break;
    if (OPTION_VALUE[wrapper]?.has(option)) args.shift();
  }
  return true;
}

function invocation(command: SimpleCommand): string[] {
  const args = [...command.words];
  while (args.length) {
    const first = args[0] as string;
    if (ASSIGNMENT.test(first) || CONTROL.has(first)) args.shift();
    else if (WRAPPERS.has(basename(first))) {
      if (!unwrap(args)) return [];
    } else break;
  }
  return args;
}

function protectedArgument(args: string[], matcher: ProtectedMatcher): string | undefined {
  for (const arg of args.flatMap((arg) => [arg, ...words(arg)])) {
    for (const { url, lenient } of candidates(arg)) {
      const rule = foreignKernel(url)
        ? 'foreign kernel host or CDP facade'
        : matcher.rule(url, { readOnly: lenient });
      if (rule) return `${REFUSAL} Rule: ${rule}; target: ${url}`;
    }
  }
  return undefined;
}

function dynamicRefusal(name: string): string {
  return `${REFUSAL} Rule: ${DYNAMIC} (${name}).`;
}

function scriptRefusal(
  simple: SimpleCommand,
  args: string[],
  name: string,
  matcher: ProtectedMatcher,
  depth: number,
  browserAround: boolean
): string | undefined {
  if (['source', '.'].includes(name) || /[$`]/.test(name))
    return browserAround ? dynamicRefusal(name) : undefined;
  const script = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
  if (name !== 'eval' && !(SHELLS.has(name) && script >= 0)) return undefined;
  if (simple.dynamic || depth >= MAX_DEPTH) return browserAround ? dynamicRefusal(name) : undefined;
  const source = name === 'eval' ? args.join(' ') : (args[script + 1] ?? '');
  return refused(source, matcher, depth + 1, browserAround);
}

export function refused(
  command: string,
  matcher: ProtectedMatcher,
  depth = 0,
  browserAround = /\b(?:playwright-cli|curlwright)\b/.test(command)
): string | undefined {
  for (const simple of commands(command)) {
    if (depth >= MAX_DEPTH && simple.scripts.length && browserAround)
      return dynamicRefusal('substitution');
    for (const script of simple.scripts) {
      if (depth >= MAX_DEPTH) continue;
      const reason = refused(script, matcher, depth + 1, browserAround);
      if (reason) return reason;
    }
    const [word = '', ...args] = invocation(simple);
    const name = basename(word);
    const script = scriptRefusal(simple, args, name, matcher, depth, browserAround);
    if (script) return script;
    if (!BROWSER.has(name)) continue;
    const reason = protectedArgument([...args, ...simple.input], matcher);
    if (reason) return reason;
    if (simple.dynamic) return dynamicRefusal(name);
  }
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

import { defineExtension, type Extension, hook, ToolTask } from '@earendil-works/pi-durable';
import { FACADE_PORT, kernelHost, ownKernelServer } from '../kernel/loopback.ts';
import { PROTECTED_RULES, type ProtectedMatcher, protectedMatcher } from './origins.ts';
import { words } from './shell.ts';

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
const HOSTLIKE = /^[^\s/?#]*(?:\.|%2e|[\u3002\uff0e\uff61])[^\s/?#]*(?:[/?#]\S*)?$/i;

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

function browserCommand(word: string): boolean {
  return BROWSER.has(word.slice(word.lastIndexOf('/') + 1));
}

export function refused(command: string, matcher: ProtectedMatcher): boolean {
  const all = words(command);
  if (!all.some(browserCommand)) return false;
  return all.some((word) =>
    candidates(word).some(({ url, lenient }) => forbidden(url, matcher, lenient))
  );
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
        beforeTool: (call) =>
          call.name === 'bash' && refused(commandOf(call.arguments), matcher)
            ? { block: REFUSAL }
            : undefined,
      }),
    ],
  });
}

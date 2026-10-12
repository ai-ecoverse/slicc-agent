import {
  defineExtension,
  type Extension,
  hook,
  type ToolRegistration,
  ToolTask,
  wrapTool,
} from '@earendil-works/pi-durable';
import { PROTECTED_RULES, type ProtectedMatcher, protectedMatcher } from './origins.ts';
import { words } from './shell.ts';

export const BROWSER_GUARD = 'slicc-browser-guard';
export const REFUSAL = "SLICC's own pages can't be opened or driven from the browser tools.";
export const FACADE_PORT = 9222;

const BROWSER = new Set(['playwright-cli', 'curlwright']);
const WEB = new Set(['http:', 'https:', 'ws:', 'wss:']);
const INNER = new Set(PROTECTED_RULES.innerSchemes.map((scheme) => `${scheme}:`));
const SCHEMED = /^[a-z][a-z0-9+.-]*:/i;
const EMBEDDED = /[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>(){}\\]+/gi;
const RELATIVE = /(?<![:\w/])\/\/[^\s'"`<>(){}\\/]+/g;
const PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*|-{1,2}[A-Za-z0-9-]+)=/;
const KERNEL = 'kernel.localhost';
const OWN_KERNEL = /^([1-9][0-9]{0,4})\.kernel\.localhost$/;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function ownKernelServer(host: string): boolean {
  const port = OWN_KERNEL.exec(host)?.[1];
  return port !== undefined && Number(port) <= 65535 && Number(port) !== FACADE_PORT;
}

export function foreignKernel(url: string): boolean {
  let parsed = parse(url);
  for (let depth = 0; parsed && INNER.has(parsed.protocol) && depth < 8; depth++)
    parsed = parse(parsed.href.slice(parsed.protocol.length));
  if (!parsed || !WEB.has(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/\.+$/, '');
  return (host === KERNEL || host.endsWith(`.${KERNEL}`)) && !ownKernelServer(host);
}

export function forbidden(url: string, matcher: ProtectedMatcher): boolean {
  return matcher.url(url) || foreignKernel(url);
}

export function candidates(raw: string): string[] {
  const word = raw.replace(/[\t\n\r]/g, '').replace(/^[\0- ]+|[\0- ]+$/g, '');
  const value = word.replace(PREFIX, '');
  const found = [
    word,
    value,
    ...(value.match(EMBEDDED) ?? []),
    ...(value.match(RELATIVE) ?? []).map((relative) => `https:${relative}`),
  ];
  if (!/^[/.~-]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    found.push(`https://${value}`);
  if (value.startsWith('//')) found.push(`https:${value}`);
  return found.filter((each) => SCHEMED.test(each));
}

function browserCommand(word: string): boolean {
  return BROWSER.has(word.slice(word.lastIndexOf('/') + 1));
}

export function refused(command: string, matcher: ProtectedMatcher): boolean {
  const all = words(command);
  if (!all.some(browserCommand)) return false;
  return all.some((word) => candidates(word).some((url) => forbidden(url, matcher)));
}

function commandOf(args: unknown): string {
  const command = (args as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' ? command : '';
}

export function browserGuard(
  origins: readonly string[],
  tools: readonly ToolRegistration[]
): Extension {
  const bash = tools.find((tool) => tool.name === 'bash') as ToolRegistration;
  const matcher = protectedMatcher(origins);
  return defineExtension({
    name: BROWSER_GUARD,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) =>
          call.name === bash.name && refused(commandOf(call.arguments), matcher)
            ? { block: REFUSAL }
            : undefined,
      }),
    ],
    wraps: [
      wrapTool(bash, (inner) => ({
        ...inner,
        execute(args, api, context) {
          if (!refused(commandOf(args), matcher)) return inner.execute(args, api, context);
          return Promise.resolve({ content: [{ type: 'text', text: REFUSAL }], isError: true });
        },
      })),
    ],
  });
}

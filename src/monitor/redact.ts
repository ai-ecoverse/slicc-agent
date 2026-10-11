import { scrub } from '../mcp/credentials.ts';
import { redactSecrets } from '../memory/format.ts';

export const TEXT_MAX = 160;

export function cut(text: string, max = TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function redacted(text: string, secrets: readonly string[]): string {
  return cut(redactSecrets(scrub(text, secrets)).text.replace(/\s+/g, ' ').trim());
}

const EXPORTS = /^export (?:[A-Z_][A-Z0-9_]*='(?:[^']|'\\'')*' ?)+; /;

export function commandLine(argv: readonly string[], secrets: readonly string[]): string {
  return redacted(argv.map((arg) => arg.replace(EXPORTS, '')).join(' '), secrets);
}

export function program(argv: readonly string[]): string {
  const first = argv[0] ?? '';
  return cut(first.split('/').pop() || first);
}

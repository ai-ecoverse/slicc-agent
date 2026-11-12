import { redactSecrets } from '../memory/format.ts';
import { cleanLabel } from '../titles/shown.ts';

export const INTENT_TOOLS: ReadonlySet<string> = new Set(['bash', 'codemode']);

export function intentOf(name: string, args: unknown): string {
  if (!INTENT_TOOLS.has(name)) return '';
  const said = (args as { intent?: unknown } | null | undefined)?.intent;
  return typeof said === 'string' ? redactSecrets(cleanLabel(said)).text : '';
}

export function withoutIntent<T extends object>(name: string, args: T): T {
  if (!INTENT_TOOLS.has(name) || !Object.hasOwn(args, 'intent')) return args;
  const { intent: _, ...rest } = args as T & { intent?: unknown };
  return rest as T;
}

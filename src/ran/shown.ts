import type { Ran, RanProgram } from '../kernel/trace.ts';
import { redactSecrets } from '../memory/format.ts';
import { cleanLabel } from '../titles/shown.ts';

export const RAN_KEY = 'ran';
export const META_PROGRAMS = 8;

type Json = Record<string, unknown>;

const isProgram = (value: unknown): value is RanProgram =>
  typeof (value as RanProgram | null)?.name === 'string';

export function ranOf(details: unknown): Ran | undefined {
  const ran = (details as Json | null | undefined)?.[RAN_KEY] as Ran | undefined;
  if (!ran || !Array.isArray(ran.programs) || typeof ran.ms !== 'number') return undefined;
  return { ...ran, programs: ran.programs.filter(isProgram) };
}

export function saidIntent(raw: string | undefined): string {
  return raw ? redactSecrets(cleanLabel(raw)).text : '';
}

export function listed(names: readonly string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function some(ran: Ran, limit: number): string[] {
  const names = ran.programs.map((program) => program.name);
  const shown = names.slice(0, limit);
  return names.length > limit || ran.more || ran.dropped ? [...shown, 'more'] : shown;
}

export function ranTitle(ran: Ran): string | undefined {
  return ran.programs.length ? `Running ${listed(some(ran, 3))}` : undefined;
}

export function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function ranMeta(ran: Ran): string {
  const what = ran.programs.length
    ? `Ran ${listed(some(ran, META_PROGRAMS))}`
    : 'Ran only shell builtins';
  return `${what} · ${seconds(ran.ms)}`;
}

export function failed(program: RanProgram): string | undefined {
  if (program.status === undefined || program.status === 0 || program.quiet) return undefined;
  return program.signal
    ? `${program.name} was killed (${program.signal})`
    : `${program.name} exited ${program.status}`;
}

export function ranFailures(ran: Ran): string[] {
  return ran.programs.map(failed).filter((text) => text !== undefined);
}

export function ranLine(ran: Ran | undefined): string {
  if (!ran) return '';
  const names = ran.programs.map((program) => program.name);
  if (!names.length) return 'ran: only shell builtins';
  const failures = ranFailures(ran);
  return `ran: ${names.join(', ')}${failures.length ? `; ${failures.join(', ')}` : ''}`;
}

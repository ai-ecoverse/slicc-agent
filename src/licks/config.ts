import { parseSchedule } from './cron.ts';
import type { LickTarget } from './lick.ts';

export interface CronEntry {
  name: string;
  schedule: string;
  target: LickTarget;
  message: string;
}

export interface WatchEntry {
  name: string;
  path: string;
  glob: string;
  target: LickTarget;
  message: string;
  debounce: number;
}

export interface WebhookEntry {
  name: string;
  target: LickTarget;
  message: string;
}

export interface ConfigError {
  file: string;
  line?: number;
  error: string;
}

export interface Parsed<T> {
  entries: T[];
  errors: ConfigError[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TARGET = /^(?:cone|scoop:[a-z0-9][a-z0-9._-]{0,63})$/;
const DEBOUNCE = { min: 100, max: 60_000, default: 500 };

export function isName(value: string): boolean {
  return NAME.test(value);
}

export function isTarget(value: string): value is LickTarget {
  return TARGET.test(value);
}

function scheduleOf(tokens: string[]): [string, string[]] {
  if (tokens[0]?.startsWith('@')) return [tokens[0], tokens.slice(1)];
  return [tokens.slice(0, 5).join(' '), tokens.slice(5)];
}

function cronLine(text: string): CronEntry {
  const [schedule, rest] = scheduleOf(text.trim().split(/\s+/));
  parseSchedule(schedule);
  const [name, maybeTarget, ...words] = rest;
  if (name === undefined) throw new Error('a name must follow the schedule');
  if (!isName(name))
    throw new Error(
      `name "${name}" must be 1–64 of a-z, 0-9, ".", "_" or "-", starting with a letter or digit`
    );
  const target = maybeTarget !== undefined && isTarget(maybeTarget) ? maybeTarget : 'cone';
  const message = (target === maybeTarget ? words : [maybeTarget, ...words])
    .filter(Boolean)
    .join(' ');
  return { name, schedule, target, message };
}

export function parseCrontab(file: string, text: string): Parsed<CronEntry> {
  const entries: CronEntry[] = [];
  const errors: ConfigError[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    try {
      const entry = cronLine(line);
      if (seen.has(entry.name)) throw new Error(`name "${entry.name}" is used twice`);
      seen.add(entry.name);
      entries.push(entry);
    } catch (error) {
      errors.push({ file, line: index + 1, error: (error as Error).message });
    }
  });
  return { entries, errors };
}

type Json = Record<string, unknown>;

function object(text: string, keys: readonly string[]): Json {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('must be a JSON object');
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length)
    throw new Error(
      `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (allowed: ${keys.join(', ')})`
    );
  return value as Json;
}

function text(value: unknown, field: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`"${field}" must be a string`);
  return value;
}

function target(value: unknown): LickTarget {
  const chosen = text(value, 'target', 'cone');
  if (!isTarget(chosen))
    throw new Error(`"target" must be "cone" or "scoop:<name>", not "${chosen}"`);
  return chosen;
}

export function nameOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (!base.endsWith('.json')) throw new Error('must end in .json');
  const name = base.slice(0, -'.json'.length);
  if (!isName(name))
    throw new Error(
      `file name "${name}" must be 1–64 of a-z, 0-9, ".", "_" or "-", starting with a letter or digit`
    );
  return name;
}

function absolute(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  if (!path.startsWith('/'))
    throw new Error(`"path" must be absolute or start with ~/, not "${path}"`);
  return path;
}

function debounce(value: unknown): number {
  if (value === undefined) return DEBOUNCE.default;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < DEBOUNCE.min ||
    value > DEBOUNCE.max
  )
    throw new Error(
      `"debounce" must be a whole number of milliseconds from ${DEBOUNCE.min} to ${DEBOUNCE.max}`
    );
  return value;
}

export function parseWatch(file: string, source: string, home: string): WatchEntry {
  const name = nameOf(file);
  const json = object(source, ['path', 'glob', 'target', 'message', 'debounce']);
  const glob = text(json.glob, 'glob', '**');
  if (glob === '' || glob.startsWith('/'))
    throw new Error('"glob" must be relative to "path", such as "**/*.md"');
  return {
    name,
    path: absolute(text(json.path, 'path'), home).replace(/\/+$/, '') || '/',
    glob,
    target: target(json.target),
    message: text(json.message, 'message', ''),
    debounce: debounce(json.debounce),
  };
}

export function parseWebhook(file: string, source: string): WebhookEntry {
  const name = nameOf(file);
  const json = object(source, ['target', 'message']);
  return { name, target: target(json.target), message: text(json.message, 'message', '') };
}

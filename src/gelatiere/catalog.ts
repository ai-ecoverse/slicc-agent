import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { redactSecrets } from '../memory/format.ts';
import { STORE_DIR } from './store.ts';

export const CATALOG_BASE = 'https://www.sliccy.com/skills/';
export const CATALOG_DIR = `${STORE_DIR}/catalog`;
export const PROFILE = '.welcome.json';
export const MAX_AGE = 12 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024;
const WEIGHTS = { apps: 3, tasks: 2, role: 1, purpose: 1 };
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const PATH = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,55}$/;

export type Row = Record<string, string>;

export interface Profile {
  purpose: string;
  role: string;
  tasks: string[];
  apps: string[];
  company?: string;
}

export interface Affinity {
  apps: string[];
  tasks: string[];
  role: string[];
  purpose: string[];
}

export interface CatalogSkill {
  name: string;
  title: string;
  description: string;
  repo: string;
  skill?: string;
  path?: string;
  all: boolean;
  affinity: Affinity;
  boost?: number;
}

export interface CatalogUseCase {
  name: string;
  title: string;
  description: string;
  prompt: string;
  skills: string[];
  affinity: Affinity;
  boost?: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type Freshness = 'fresh' | 'cached' | 'missing' | 'unavailable';

export interface Sheet {
  url: string;
  rows: Row[];
  state: Freshness;
  fetchedAt?: number;
}

function words(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return redactSecrets(value.trim()).text.slice(0, limit);
}

function boostOf(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function affinityOf(row: Row): Affinity {
  return {
    apps: words(row.apps),
    tasks: words(row.tasks),
    role: words(row.role),
    purpose: words(row.purpose),
  };
}

function nameOf(value: unknown): string | undefined {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return NAME.test(name) ? name : undefined;
}

export function truthy(value: unknown): boolean {
  return typeof value === 'string' && ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

export function parseSkills(rows: readonly Row[]): CatalogSkill[] {
  const out: CatalogSkill[] = [];
  for (const row of rows) {
    const name = nameOf(row.name);
    const repo = typeof row.repo === 'string' ? row.repo.trim() : '';
    const skill = typeof row.skill === 'string' ? row.skill.trim() : '';
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const all = truthy(row.installAll);
    if (!name || !REPO.test(repo)) continue;
    if (!all && !SKILL.test(skill)) continue;
    if (path && !PATH.test(path)) continue;
    const boost = boostOf(row.boost);
    out.push({
      name,
      title: clean(row.displayName, 80) || name,
      description: clean(row.description, 500),
      repo,
      ...(all ? {} : { skill }),
      ...(path ? { path } : {}),
      all,
      affinity: affinityOf(row),
      ...(boost === undefined ? {} : { boost }),
    });
  }
  return out;
}

export function parseUseCases(rows: readonly Row[]): CatalogUseCase[] {
  const out: CatalogUseCase[] = [];
  for (const row of rows) {
    const name = nameOf(row.name);
    const prompt = clean(row.prompt, 1000);
    if (!name || !prompt) continue;
    const boost = boostOf(row.boost);
    out.push({
      name,
      title: clean(row.displayName, 80) || name,
      description: clean(row.description, 500),
      prompt,
      skills: words(row.skills),
      affinity: affinityOf(row),
      ...(boost === undefined ? {} : { boost }),
    });
  }
  return out;
}

export function merge(base: CatalogSkill[], company: CatalogSkill[]): CatalogSkill[] {
  const names = new Set(company.map((entry) => entry.name));
  return [...base.filter((entry) => !names.has(entry.name)), ...company];
}

export function slugifyCompany(company: unknown): string | null {
  if (typeof company !== 'string' || !company) return null;
  const slug = company
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
  return slug || null;
}

export function profileOf(value: unknown): Profile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const list = (field: unknown) =>
    Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
  const text = (field: unknown) => (typeof field === 'string' ? field : '');
  return {
    purpose: text(raw.purpose),
    role: text(raw.role),
    tasks: list(raw.tasks),
    apps: list(raw.apps),
    ...(typeof raw.company === 'string' && raw.company ? { company: raw.company } : {}),
  };
}

export interface Scored {
  score: number;
  reasons: string[];
}

export function score(
  entry: { affinity: Affinity; boost?: number },
  profile: Profile | undefined
): Scored {
  if (!profile) return { score: entry.boost ?? 1, reasons: [] };
  let total = 0;
  const reasons: string[] = [];
  const apps = entry.affinity.apps.filter((app) => profile.apps.includes(app));
  if (apps.length) {
    total += apps.length * WEIGHTS.apps;
    reasons.push(`apps(${apps.join(', ')})`);
  }
  const tasks = entry.affinity.tasks.filter((task) => profile.tasks.includes(task));
  if (tasks.length) {
    total += tasks.length * WEIGHTS.tasks;
    reasons.push(`tasks(${tasks.join(', ')})`);
  }
  if (profile.role && entry.affinity.role.includes(profile.role)) {
    total += WEIGHTS.role;
    reasons.push(`role(${profile.role})`);
  }
  if (profile.purpose && entry.affinity.purpose.includes(profile.purpose)) {
    total += WEIGHTS.purpose;
    reasons.push(`purpose(${profile.purpose})`);
  }
  return { score: total * (entry.boost ?? 1), reasons };
}

function rowsOf(value: unknown): Row[] | undefined {
  const data = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return data.filter((row): row is Row => Boolean(row) && typeof row === 'object');
}

async function download(
  fetcher: Fetcher,
  url: string
): Promise<{ rows: Row[] } | 'missing' | undefined> {
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' } });
    if (response.status === 404) return 'missing';
    if (response.status !== 200) return undefined;
    const text = await response.text();
    if (text.length > MAX_BYTES) return undefined;
    const rows = rowsOf(JSON.parse(text));
    return rows ? { rows } : undefined;
  } catch {
    return undefined;
  }
}

interface Cached {
  url: string;
  fetchedAt: number;
  rows: Row[];
}

async function cached(
  env: Pick<ExecutionEnv, 'readTextFile'>,
  file: string,
  url: string,
  context: Context
): Promise<Cached | undefined> {
  const read = await env.readTextFile(file, context);
  if (!read.ok) return undefined;
  try {
    const parsed = JSON.parse(read.value) as Cached;
    return parsed.url === url && typeof parsed.fetchedAt === 'number' && Array.isArray(parsed.rows)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export interface SheetOptions {
  env: Pick<ExecutionEnv, 'readTextFile' | 'writeFile' | 'createDir'>;
  fetcher: Fetcher;
  now: number;
  refresh: boolean;
}

export async function sheet(
  options: SheetOptions,
  url: string,
  file: string,
  context: Context
): Promise<Sheet> {
  const { env, fetcher, now, refresh } = options;
  const kept = await cached(env, file, url, context);
  if (kept && !refresh && now - kept.fetchedAt < MAX_AGE)
    return {
      url,
      rows: kept.rows,
      state: kept.rows.length ? 'fresh' : 'missing',
      fetchedAt: kept.fetchedAt,
    };
  const got = await download(fetcher, url);
  if (got === undefined)
    return kept
      ? { url, rows: kept.rows, state: 'cached', fetchedAt: kept.fetchedAt }
      : { url, rows: [], state: 'unavailable' };
  const rows = got === 'missing' ? [] : got.rows;
  await env.createDir(CATALOG_DIR, { recursive: true }, context);
  await env.writeFile(file, `${JSON.stringify({ url, fetchedAt: now, rows })}\n`, context);
  return { url, rows, state: got === 'missing' ? 'missing' : 'fresh', fetchedAt: now };
}

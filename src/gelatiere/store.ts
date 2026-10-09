import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { redactSecrets } from '../memory/format.ts';
import { SUGGESTIONS_DIR, SUGGESTIONS_STORE } from '../sprinkles/sprinkles.ts';

export const STORE_DIR = SUGGESTIONS_DIR;
export const STORE = SUGGESTIONS_STORE;
export const KINDS = ['skill', 'use-case', 'tip', 'skill-idea', 'issue'] as const;
export const MAX_OPEN = 50;
const PROMPTED = new Set<Kind>(['use-case', 'skill-idea', 'issue']);

export type Kind = (typeof KINDS)[number];

export interface Suggestion {
  id: string;
  kind: Kind;
  title: string;
  body: string;
  evidence?: string;
  skill?: string;
  repo?: string;
  install?: string;
  prompt?: string;
  url?: string;
  cones: string[];
  createdAt: number;
  deliveredAt?: number;
  dismissedAt?: number;
  takenAt?: number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = redactSecrets(value.trim()).text;
  return clean ? clean.slice(0, limit) : undefined;
}

function origin(skill: string | undefined, repo: string | undefined): string {
  return `${skill} from github.com/${repo}`;
}

function kindProblem(
  kind: Kind,
  skill: string | undefined,
  repo: string | undefined,
  prompt: string | undefined
): string | undefined {
  if (kind === 'skill' && (!skill || !SKILL.test(skill)))
    return 'a skill needs its name (letters, digits, spaces, . _ -)';
  if (kind === 'skill' && (!repo || !REPO.test(repo)))
    return 'a skill needs its repo, a GitHub owner/repo';
  if (PROMPTED.has(kind) && !prompt) return `a ${kind} needs its prompt`;
  return undefined;
}

function shapeProblem(url: string | undefined, cones: string[]): string | undefined {
  if (url !== undefined && !/^https:\/\/[^\s"'<>]+$/.test(url)) return 'url must be https';
  if (cones.some((cone) => !CONE.test(cone))) return 'cones must be cone ids';
  return undefined;
}

export function validate(candidate: unknown): Suggestion | string {
  if (!candidate || typeof candidate !== 'object') return 'not an object';
  const item = candidate as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  if (!ID.test(id)) return `id "${String(item.id)}" must be 1–64 of a-z, 0-9 and -`;
  if (!KINDS.includes(item.kind as Kind)) return `${id}: kind must be one of ${KINDS.join(', ')}`;
  const title = text(item.title, 120);
  const body = text(item.body, 600);
  if (!title || !body) return `${id}: needs a title and a body`;
  const skill = typeof item.skill === 'string' ? item.skill.trim() : undefined;
  const repo = typeof item.repo === 'string' ? item.repo.trim() : undefined;
  const url = typeof item.url === 'string' ? item.url.trim() : undefined;
  const cones = Array.isArray(item.cones)
    ? item.cones.filter((cone): cone is string => typeof cone === 'string')
    : [];
  const evidence = text(item.evidence, 300);
  const prompt = text(item.prompt, 1000);
  const problem = kindProblem(item.kind as Kind, skill, repo, prompt) ?? shapeProblem(url, cones);
  if (problem) return `${id}: ${problem}`;
  const installs = item.kind === 'skill' ? { skill, repo, install: origin(skill, repo) } : {};
  return {
    id,
    kind: item.kind as Kind,
    title,
    body,
    ...(evidence ? { evidence } : {}),
    ...installs,
    ...(prompt ? { prompt } : {}),
    ...(url ? { url } : {}),
    cones,
    createdAt: 0,
  };
}

export function fold(
  store: readonly Suggestion[],
  candidates: unknown,
  now: number
): { store: Suggestion[]; added: number; updated: number; rejected: string[] } {
  const next = store.map((item) => ({ ...item }));
  const rejected: string[] = [];
  let added = 0;
  let updated = 0;
  if (!Array.isArray(candidates))
    return { store: next, added, updated, rejected: ['not a JSON array'] };
  for (const candidate of candidates) {
    const checked = validate(candidate);
    if (typeof checked === 'string') {
      rejected.push(checked);
      continue;
    }
    const at = next.findIndex((item) => item.id === checked.id);
    const old = next[at];
    if (old) {
      if (old.dismissedAt || old.takenAt) continue;
      next[at] = { ...checked, createdAt: old.createdAt };
      updated++;
    } else if (open(next).length >= MAX_OPEN)
      rejected.push(`${checked.id}: ${MAX_OPEN} suggestions are already open`);
    else {
      next.push({ ...checked, createdAt: now });
      added++;
    }
  }
  return { store: next, added, updated, rejected };
}

export function open(store: readonly Suggestion[]): Suggestion[] {
  return store.filter((item) => !item.dismissedAt && !item.takenAt);
}

export async function readStore(
  env: Pick<ExecutionEnv, 'readTextFile'>,
  context: Context
): Promise<Suggestion[] | null> {
  const read = await env.readTextFile(STORE, context);
  if (!read.ok) return null;
  try {
    const parsed = JSON.parse(read.value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Suggestion => typeof validate(item) !== 'string')
      : [];
  } catch {
    return [];
  }
}

export async function writeStore(
  env: Pick<ExecutionEnv, 'writeFile' | 'createDir'>,
  store: readonly Suggestion[],
  context: Context
): Promise<void> {
  await env.createDir(STORE_DIR, { recursive: true }, context);
  const written = await env.writeFile(STORE, `${JSON.stringify(store, null, 2)}\n`, context);
  if (!written.ok) throw new Error(written.error.message);
}

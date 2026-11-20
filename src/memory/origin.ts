import { defineDoc } from '@earendil-works/pi-durable';
import { splitUser } from '../attachments.ts';
import { boundedDeltas } from '../checkpoints.ts';
import { GUEST_INPUT_KIND } from '../guests/attribution.ts';
import { entryLick } from '../licks/state.ts';
import { FROM_KIND, type From } from '../scoops/from.ts';
import type { MemoryDoc, MemoryEntry, MemoryOrigin } from './format.ts';

export type OriginRecord = { hash: string; origin: MemoryOrigin };

export type OriginState = { scopes: Record<string, Record<string, OriginRecord>> };

export const MemoryOriginDoc = defineDoc<OriginState>({
  kind: 'slicc.memory-origin',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ scopes: {} }),
});

export type InputOriginState = { typed: Record<string, string> };

export const InputOriginDoc = defineDoc<InputOriginState>({
  kind: 'slicc.input-origin',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ typed: {} }),
});

type Turn = { id: number; kind: string; data?: unknown; model?: readonly unknown[] };

export function ownerTurns(entries: readonly Turn[]): Set<number> {
  const noted = new Set<number>();
  for (const entry of entries) if (entry.kind === FROM_KIND) noted.add((entry.data as From).entry);
  return new Set(
    entries
      .filter((entry) => entry.kind === 'pi.user' && !noted.has(entry.id) && !entryLick(entry))
      .map((entry) => entry.id)
  );
}

export function turnOrigin(entry: Turn, role: string, owned: ReadonlySet<number>): MemoryOrigin {
  if (role === 'assistant') return 'agent';
  if (owned.has(entry.id)) return 'owner';
  return entry.kind === GUEST_INPUT_KIND ? 'guest' : 'mixed';
}

export function combined(origins: readonly MemoryOrigin[]): MemoryOrigin {
  const kinds = new Set(origins);
  return kinds.size === 1 ? (origins[0] as MemoryOrigin) : 'mixed';
}

export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const saidText = (content: unknown) => splitUser(content).text;

const SKILL_BLOCK = /^<skill name="([^"]*)" location="[^"]*">\n/;
const SKILL_END = '\n</skill>';

export function typedSkill(text: string): string {
  const skill = SKILL_BLOCK.exec(text);
  const end = text.lastIndexOf(SKILL_END);
  if (!skill || end < 0) return text;
  const args = text.slice(end + SKILL_END.length).trim();
  return args ? `/skill:${skill[1]} ${args}` : `/skill:${skill[1]}`;
}

async function typedText(content: unknown, state: Readonly<InputOriginState> | null | undefined) {
  const said = saidText(content);
  const typed = state ? state.typed[await textHash(said)] : undefined;
  return (typed ?? typedSkill(said)).trim();
}

export async function ownerTexts(
  entries: readonly Turn[],
  state: Readonly<InputOriginState> | null | undefined,
  limit = Number.POSITIVE_INFINITY
): Promise<Map<number, string>> {
  const owned = ownerTurns(entries);
  const found: [number, string][] = [];
  let kept = 0;
  for (let at = entries.length - 1; at >= 0 && kept < limit; at--) {
    const entry = entries[at] as Turn;
    if (!owned.has(entry.id)) continue;
    const text = await typedText((entry.model?.[0] as { content?: unknown })?.content, state);
    found.push([entry.id, text]);
    if (text) kept++;
  }
  return new Map(found.reverse());
}

type Hashed = Pick<MemoryEntry, 'section' | 'title' | 'tag' | 'body'>;

export const originKey = (entry: Pick<MemoryEntry, 'section' | 'title'>) =>
  `${entry.section.toLowerCase()}\n${entry.title.toLowerCase()}`;

export async function entryHash(entry: Hashed): Promise<string> {
  return textHash(JSON.stringify([entry.section, entry.title, entry.tag, entry.body]));
}

export async function originOf(
  scope: string,
  entry: Hashed,
  state: Readonly<OriginState> | null | undefined
): Promise<MemoryOrigin | null> {
  const record = state?.scopes[scope]?.[originKey(entry)];
  return record && record.hash === (await entryHash(entry)) ? record.origin : null;
}

export async function withOrigins(
  entries: readonly MemoryEntry[],
  state: Readonly<OriginState> | null | undefined
): Promise<MemoryEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const origin = entry.source === 'entry' ? await originOf(entry.scope, entry, state) : null;
      return origin ? { ...entry, origin } : entry;
    })
  );
}

export async function ownedDoc(
  doc: MemoryDoc,
  scope: string,
  state: Readonly<OriginState> | null | undefined
): Promise<MemoryDoc> {
  const sections = await Promise.all(
    doc.sections.map(async (section) => {
      const kept = await Promise.all(
        section.entries.map(async (entry) =>
          (await originOf(scope, { ...entry, section: section.name }, state)) === 'owner'
            ? [entry]
            : []
        )
      );
      return { name: section.name, intro: '', entries: kept.flat() };
    })
  );
  return { head: '', sections: sections.filter((section) => section.entries.length) };
}

export function recorded(
  before: Readonly<Record<string, OriginRecord>> | undefined,
  present: readonly MemoryEntry[],
  saved: { key: string; hash: string; origin: MemoryOrigin } | null
): Record<string, OriginRecord> {
  const next: Record<string, OriginRecord> = {};
  for (const entry of present) {
    const key = originKey(entry);
    const kept = before?.[key];
    if (entry.source === 'entry' && kept) next[key] = kept;
  }
  if (saved) {
    const kept = before?.[saved.key];
    next[saved.key] =
      kept?.hash === saved.hash && kept.origin === 'owner'
        ? kept
        : { hash: saved.hash, origin: saved.origin };
  }
  return next;
}

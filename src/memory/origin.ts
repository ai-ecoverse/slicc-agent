import type { Context } from '@earendil-works/chord/context';
import {
  type Conversation,
  type Cursor,
  defineDoc,
  type Harness,
  type InputSubmissionDraft,
  type SubmissionId,
  type Tx,
} from '@earendil-works/pi-durable';
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

export const INPUT_RECORDS = 500;

export type InputRecord = { conversation: number; hash: string; typed?: string };

export type InputOriginState = { since: number | null; inputs: Record<string, InputRecord> };

export const InputOriginDoc = defineDoc<InputOriginState>({
  kind: 'slicc.input-origin',
  checkpointWhen: boundedDeltas,
  version: 1,
  scope: 'session',
  initial: () => ({ since: null, inputs: {} }),
});

type Turn = {
  id: number;
  conversationId?: number;
  kind: string;
  data?: unknown;
  model?: readonly unknown[];
};

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

const LEGACY_SKILL =
  /^<skill name="([a-z0-9-]{1,64})" location="[^"\n]*">\nReferences are relative to [^\n]*\.\n\n/;
const SKILL_END = '\n</skill>';

export function legacyText(said: string): string {
  if (!said.trimStart().startsWith('<skill')) return said;
  const skill = LEGACY_SKILL.exec(said);
  const end = said.lastIndexOf(SKILL_END);
  const after = said.slice(end + SKILL_END.length);
  return skill && end > 0 && (!after || after.startsWith('\n\n')) ? `/skill:${skill[1]}` : '';
}

async function newestEntry(tx: Tx): Promise<number> {
  let newest = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const conversation of page.items)
      newest = Math.max(newest, (await tx.latestEntryId(conversation.id)) ?? 0);
    cursor = page.next;
  } while (cursor);
  return newest;
}

export async function submitTyped(
  harness: Pick<Harness, 'commit'>,
  conversation: Pick<Conversation, 'id' | 'submit'>,
  draft: InputSubmissionDraft,
  typed: string | undefined,
  context: Context
): Promise<SubmissionId> {
  const hash = await textHash(saidText(draft.content));
  return harness.commit(async (tx) => {
    const doc = await tx.doc(InputOriginDoc);
    if (doc.since === null) doc.since = await newestEntry(tx);
    const id = await conversation.submit(tx, draft);
    doc.inputs[String(id)] ??= {
      conversation: conversation.id,
      hash,
      ...(typed === undefined ? {} : { typed }),
    };
    const keys = Object.keys(doc.inputs).sort((a, b) => Number(a) - Number(b));
    for (const key of keys.slice(0, Math.max(0, keys.length - INPUT_RECORDS)))
      delete doc.inputs[key];
    return id;
  }, context);
}

type Sent = ReadonlyMap<string, ReadonlySet<string | null>>;

function sentOf(state: Readonly<InputOriginState>): Sent {
  const sent = new Map<string, Set<string | null>>();
  for (const record of Object.values(state.inputs)) {
    const key = `${record.conversation}:${record.hash}`;
    const typed = sent.get(key) ?? new Set();
    typed.add(record.typed ?? null);
    sent.set(key, typed);
  }
  return sent;
}

async function typedText(
  entry: Turn,
  state: Readonly<InputOriginState> | null | undefined,
  sent: Sent
): Promise<string> {
  const said = saidText((entry.model?.[0] as { content?: unknown } | undefined)?.content);
  if (!state || state.since === null || entry.id <= state.since) return legacyText(said).trim();
  const typed = sent.get(`${entry.conversationId}:${await textHash(said)}`);
  if (typed?.size !== 1) return '';
  return ([...typed][0] ?? said).trim();
}

export async function ownerTexts(
  entries: readonly Turn[],
  state: Readonly<InputOriginState> | null | undefined,
  limit = Number.POSITIVE_INFINITY
): Promise<Map<number, string>> {
  const owned = ownerTurns(entries);
  const sent = state ? sentOf(state) : new Map();
  const found: [number, string][] = [];
  for (let at = entries.length - 1; at >= 0 && found.length < limit; at--) {
    const entry = entries[at] as Turn;
    if (owned.has(entry.id)) found.push([entry.id, await typedText(entry, state, sent)]);
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

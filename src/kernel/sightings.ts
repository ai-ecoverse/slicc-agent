import type { KernelClient, KernelProcess } from './client.ts';
import { boundedPs, PS_MS } from './jobs.ts';

export const TAINT_TAG = 'slicc-taint:';
export const CRON_TAGS = '/var/spool/cron/tags';

const TAGGED = /slicc-taint:[0-9a-f-]+/g;

export type Recent = { tag: string; uids: number[] | null };

export type SeenRow = {
  pid: number;
  uid?: number;
  started?: number;
  tag?: string;
  tags?: readonly string[];
};

export interface Sightings {
  spawned(process: KernelProcess, tag: string): void;
  observe(rows: readonly SeenRow[]): Promise<void>;
  recent(pid: number, rows: readonly SeenRow[]): Recent[];
}

type Entry = { uids: Set<number>; unseen: boolean; gone: number | undefined };

type Client = Pick<KernelClient, 'ps' | 'fs'>;

export function tagsOf(row: { tag?: string; tags?: readonly string[] }): string[] {
  if (row.tags?.length) return [...row.tags];
  return row.tag === undefined ? [] : [row.tag];
}

const keyOf = (row: SeenRow) => `${row.pid}:${row.started ?? ''}`;

async function uids(client: Client): Promise<Map<string, number>> {
  const text = await client.fs.readText('/etc/passwd').catch(() => '');
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && Number.isInteger(Number(uid)) && uid !== '') out.set(name, Number(uid));
  }
  return out;
}

function parsed(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function cronHeld(client: Client): Promise<Map<string, number | null>> {
  const held = new Map<string, number | null>();
  const text = await client.fs.readText(CRON_TAGS).catch(() => '');
  if (!text.includes(TAINT_TAG)) return held;
  const tables = parsed(text);
  if (!tables) {
    for (const tag of text.match(TAGGED) ?? []) held.set(tag, null);
    return held;
  }
  const byName = await uids(client);
  for (const [path, table] of Object.entries(tables)) {
    const uid = byName.get(path.slice(path.lastIndexOf('/') + 1));
    for (const tag of JSON.stringify(table).match(TAGGED) ?? [])
      held.set(tag, held.has(tag) || uid === undefined ? null : uid);
  }
  return held;
}

export function sightings(
  client: Client,
  poll = PS_MS,
  warn: (message: string) => void = () => undefined
): Sightings {
  const entries = new Map<string, Entry>();
  const first = new Map<string, number>();
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const entry = (tag: string) => {
    const found = entries.get(tag) ?? { uids: new Set<number>(), unseen: false, gone: undefined };
    entries.set(tag, found);
    return found;
  };
  const sawRows = (rows: readonly SeenRow[]) => {
    const alive = new Set<string>();
    for (const row of rows)
      for (const tag of tagsOf(row).filter((name) => name.startsWith(TAINT_TAG))) {
        const found = entry(tag);
        alive.add(tag);
        found.unseen = false;
        found.gone = undefined;
        if (row.uid !== undefined) found.uids.add(row.uid);
      }
    return alive;
  };
  const sawHeld = (held: ReadonlyMap<string, number | null>) => {
    for (const [tag, uid] of held) {
      const found = entry(tag);
      found.gone = undefined;
      if (uid === null) found.unseen = true;
      else found.uids.add(uid);
    }
  };
  const stamp = (rows: readonly SeenRow[]) => {
    const keys = new Set(rows.map(keyOf));
    for (const key of [...first.keys()]) if (!keys.has(key)) first.delete(key);
    for (const key of keys) if (!first.has(key)) first.set(key, seq);
  };
  const look = async (rows: readonly SeenRow[]) => {
    seq += 1;
    const held = await cronHeld(client);
    const alive = sawRows(rows);
    sawHeld(held);
    for (const [tag, found] of entries)
      if (!alive.has(tag) && !held.has(tag) && found.gone === undefined) found.gone = seq;
    stamp(rows);
    const waiting = [...entries].some(([tag, found]) => found.gone === undefined && !held.has(tag));
    if (waiting && timer === undefined) timer = setTimeout(tick, poll);
  };
  const observe = (rows: readonly SeenRow[]) => {
    const next = chain.then(() => look(rows));
    chain = next.catch(() => undefined);
    return next;
  };
  const fresh = async () => {
    const rows = await boundedPs(client, warn, poll);
    if (rows) await observe(rows).catch(() => undefined);
  };
  function tick() {
    timer = undefined;
    void fresh();
  }
  return {
    spawned(process, tag) {
      const found = entry(tag);
      found.gone = undefined;
      if (!found.uids.size) found.unseen = true;
      const ended = () => void fresh();
      process.exited.then(ended, ended);
    },
    observe,
    recent(pid, rows) {
      const row = rows.find((candidate) => candidate.pid === pid);
      const since = (row && first.get(keyOf(row))) ?? seq;
      return [...entries]
        .filter(([, found]) => found.gone === undefined || found.gone >= since)
        .map(([tag, found]) => ({ tag, uids: found.unseen ? null : [...found.uids] }));
    },
  };
}

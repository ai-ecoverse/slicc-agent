import type { KernelClient, KernelProcess } from './client.ts';
import { boundedPs, PS_MS } from './jobs.ts';

export const TAINT_TAG = 'slicc-taint:';
export const CRON_TAGS = '/var/spool/cron/tags';

const TAGGED = /slicc-taint:[0-9a-f-]+/g;

export type SeenRow = {
  pid: number;
  started?: number;
  tag?: string;
  tags?: readonly string[];
};

export interface Sightings {
  mark(): number;
  spawned(process: KernelProcess, tag: string): void;
  observe(rows: readonly SeenRow[], at: number): Promise<void>;
  recent(pid: number, rows: readonly SeenRow[], at: number): string[];
}

type Entry = { seen: number; gone: number | undefined };

type Client = Pick<KernelClient, 'ps' | 'fs'>;

export function tagsOf(row: { tag?: string; tags?: readonly string[] }): string[] {
  if (row.tags?.length) return [...row.tags];
  return row.tag === undefined ? [] : [row.tag];
}

const keyOf = (row: SeenRow) => `${row.pid}:${row.started ?? ''}`;

export async function cronHeld(client: Client): Promise<Set<string> | null> {
  try {
    return new Set((await client.fs.readText(CRON_TAGS)).match(TAGGED) ?? []);
  } catch (error) {
    return (error as { code?: unknown }).code === 'ENOENT' ? new Set() : null;
  }
}

export function sightings(
  client: Client,
  poll = PS_MS,
  warn: (message: string) => void = () => undefined
): Sightings {
  const entries = new Map<string, Entry>();
  const first = new Map<string, number>();
  let clock = 0;
  let newest = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mark = () => ++clock;
  const alive = (tag: string, at: number) => {
    const found = entries.get(tag) ?? { seen: at, gone: undefined };
    found.seen = Math.max(found.seen, at);
    found.gone = undefined;
    entries.set(tag, found);
  };
  const stamp = (rows: readonly SeenRow[], at: number) => {
    const keys = new Set(rows.map(keyOf));
    for (const key of keys) first.set(key, Math.min(first.get(key) ?? at, at));
    if (at < newest) return;
    newest = at;
    for (const key of [...first.keys()]) if (!keys.has(key)) first.delete(key);
  };
  const observe = async (rows: readonly SeenRow[], at: number) => {
    const held = await cronHeld(client);
    const carried = new Set(
      rows.flatMap((row) => tagsOf(row).filter((tag) => tag.startsWith(TAINT_TAG)))
    );
    for (const tag of [...carried, ...(held ?? entries.keys())]) alive(tag, at);
    for (const [tag, found] of entries)
      if (
        !carried.has(tag) &&
        held &&
        !held.has(tag) &&
        found.gone === undefined &&
        found.seen < at
      )
        found.gone = at;
    stamp(rows, at);
    const waiting = [...entries].some(
      ([tag, found]) => found.gone === undefined && !held?.has(tag)
    );
    if (waiting && held && timer === undefined) timer = setTimeout(tick, poll);
  };
  const fresh = async () => {
    const at = mark();
    const rows = await boundedPs(client, warn, poll);
    if (rows) await observe(rows, at).catch(() => undefined);
  };
  function tick() {
    timer = undefined;
    void fresh();
  }
  return {
    mark,
    spawned(process, tag) {
      alive(tag, mark());
      const ended = () => void fresh();
      process.exited.then(ended, ended);
    },
    observe,
    recent(pid, rows, at) {
      const row = rows.find((candidate) => candidate.pid === pid);
      const since = (row && first.get(keyOf(row))) ?? at;
      return [...entries]
        .filter(([, found]) => found.gone === undefined || found.gone >= since)
        .map(([tag]) => tag);
    },
  };
}

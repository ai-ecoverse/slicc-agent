import type { ConversationView, EntryRecord } from '@earendil-works/pi-durable';

export interface KeptQuery {
  minEntryId?: number;
  maxEntryId?: number;
  order: 'ascending' | 'descending';
}

export type KeptLoader = (
  query: KeptQuery,
  limit: number
) => Promise<{ entries: readonly EntryRecord[]; more: boolean }>;

interface Gap {
  after: number;
  upTo: number;
  left: number;
}

export class Kept {
  readonly #load: KeptLoader;
  readonly #size: number;
  readonly #cap: number;
  #entries: EntryRecord[] = [];
  readonly #ids = new Set<number>();
  #start = false;
  #gaps: Gap[] = [];
  #earlier: Promise<void> | undefined;
  #filling: Promise<void> | undefined;

  constructor(load: KeptLoader, size: number, cap: number = Number.POSITIVE_INFINITY) {
    this.#load = load;
    this.#size = size;
    this.#cap = cap;
  }

  get entries(): readonly EntryRecord[] {
    return this.#entries;
  }

  get earlier(): boolean {
    return !this.#start;
  }

  get gap(): boolean {
    return this.#gaps.length > 0;
  }

  #add(list: readonly EntryRecord[]): void {
    const fresh = list.filter((entry) => !this.#ids.has(Number(entry.id)));
    if (!fresh.length) return;
    for (const entry of fresh) this.#ids.add(Number(entry.id));
    let last = this.#entries.at(-1)?.id ?? Number.NEGATIVE_INFINITY;
    const sorted = fresh.every((entry) => {
      const after = entry.id > last;
      last = entry.id;
      return after;
    });
    this.#entries = this.#entries.concat(fresh);
    if (!sorted) this.#entries.sort((a, b) => a.id - b.id);
  }

  merge(view: ConversationView): readonly EntryRecord[] {
    const newest = this.#entries.at(-1)?.id;
    const first = view.entries[0]?.id;
    if (view.before === undefined) this.#start = true;
    else if (newest !== undefined && first !== undefined && view.before > newest)
      this.#gaps.push({ after: Number(newest), upTo: Number(first), left: this.#cap });
    this.#add(view.entries);
    return this.#entries;
  }

  loadEarlier(): Promise<void> {
    if (this.#start) return Promise.resolve();
    this.#earlier ??= (async () => {
      const oldest = this.#entries[0]?.id;
      const query: KeptQuery =
        oldest === undefined
          ? { order: 'descending' }
          : { maxEntryId: Number(oldest) - 1, order: 'descending' };
      const page = await this.#load(query, this.#size);
      this.#add(page.entries);
      if (!page.more || !page.entries.length) this.#start = true;
    })().finally(() => {
      this.#earlier = undefined;
    });
    return this.#earlier;
  }

  #abandon(gap: Gap): void {
    this.#entries = this.#entries.filter((entry) => {
      const keep = entry.id > gap.after;
      if (!keep) this.#ids.delete(Number(entry.id));
      return keep;
    });
    this.#gaps = this.#gaps.filter((other) => other.after >= gap.upTo);
    this.#start = false;
  }

  fillGap(): Promise<void> {
    const gap = this.#gaps.at(-1);
    if (!gap) return Promise.resolve();
    this.#filling ??= (async () => {
      const page = await this.#load(
        { minEntryId: gap.after + 1, maxEntryId: gap.upTo - 1, order: 'descending' },
        Math.min(this.#size, gap.left)
      );
      this.#add(page.entries);
      const oldest = page.entries.at(-1);
      gap.left -= page.entries.length;
      if (!page.more || !oldest) this.#gaps = this.#gaps.filter((other) => other !== gap);
      else if (gap.left <= 0) this.#abandon(gap);
      else gap.upTo = Number(oldest.id);
    })().finally(() => {
      this.#filling = undefined;
    });
    return this.#filling;
  }
}

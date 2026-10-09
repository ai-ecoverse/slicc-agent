import type { Memory, MemoryDraft, MemoryEvents, MemoryPort } from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import { type MemoryScope, slugOf as slug } from '../memory/format.ts';
import { Emitter } from './emitter.ts';

type Local = Memory & { source?: 'entry' | 'notes' };

export class MemoryAdapter extends Emitter<MemoryEvents> implements MemoryPort {
  readonly #connection: AgentConnection;
  #pending = new Map<string, Local | null>();

  constructor(connection: AgentConnection) {
    super();
    this.#connection = connection;
    connection.memories?.subscribe(() => {
      this.#pending.clear();
      this.emit('memories', this.list());
    });
    connection.memoryScopes?.subscribe(() => this.emit('memories', this.list()));
  }

  list(): readonly Memory[] {
    const stored = (this.#connection.memories?.value ?? []) as Local[];
    if (!this.#pending.size) return stored;
    const out = stored.filter((item) => !this.#pending.has(item.id));
    for (const item of this.#pending.values()) if (item) out.push(item);
    return out;
  }

  scopes(): readonly MemoryScope[] {
    return this.#connection.memoryScopes?.value ?? [];
  }

  save(draft: MemoryDraft): Memory {
    const memory: Local = {
      ...draft,
      id: `${draft.scope}/${slug(draft.section)}/${slug(draft.title)}`,
      updatedAt: Date.now(),
      source: 'entry',
    };
    if (draft.id && draft.id !== memory.id) this.#pending.set(draft.id, null);
    this.#pending.set(memory.id, memory);
    this.emit('memories', this.list());
    void this.#connection.control
      .memorySave(
        {
          id: draft.id ?? null,
          scope: draft.scope,
          section: draft.section,
          title: draft.title,
          body: draft.body,
          tag: draft.tag,
        },
        BACKGROUND_CONTEXT
      )
      .catch(() => {
        this.#pending.clear();
        this.emit('memories', this.list());
      });
    return memory;
  }

  remove(id: string): void {
    this.#pending.set(id, null);
    this.emit('memories', this.list());
    void this.#connection.control.memoryRemove(id, BACKGROUND_CONTEXT).catch(() => {
      this.#pending.delete(id);
      this.emit('memories', this.list());
    });
  }
}

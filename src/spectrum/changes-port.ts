import type { Change } from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import { Emitter } from './emitter.ts';

export type RepoChange = Change & { repo?: string };

export interface ChangesEvents {
  changes: readonly RepoChange[];
}

export class ChangesAdapter extends Emitter<ChangesEvents> {
  readonly #connection: AgentConnection;
  #opened = false;

  constructor(connection: AgentConnection) {
    super();
    this.#connection = connection;
    connection.changes?.subscribe(() => this.emit('changes', this.#list()));
  }

  #open(): void {
    if (this.#opened) return;
    this.#opened = true;
    void this.#connection.control.changesOpen(BACKGROUND_CONTEXT).catch(() => undefined);
  }

  changes(): readonly RepoChange[] {
    this.#open();
    return this.#list();
  }

  #list(): readonly RepoChange[] {
    return (this.#connection.changes?.value?.changes ?? []).map((change) => ({
      path: change.path,
      repo: change.repo,
      status: change.status,
      before: change.before,
      after: change.after,
      agentId: null,
    }));
  }

  unavailable(): string | null {
    this.#open();
    return this.#connection.changes?.value?.unavailable ?? null;
  }

  accept(path: string): void {
    void this.#connection.control.changeAccept(path, BACKGROUND_CONTEXT).catch(() => undefined);
  }

  async revert(path: string): Promise<void> {
    const result = await this.#connection.control.changeRevert(path, BACKGROUND_CONTEXT);
    if (result.error !== null) throw new Error(result.error);
  }
}

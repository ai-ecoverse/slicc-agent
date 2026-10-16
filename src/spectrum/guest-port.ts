import type { GuestDraft, GuestEvents, GuestPort, GuestSeat } from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import { Emitter } from './emitter.ts';

export interface GuestHub {
  mint(request: GuestDraft & { agentId: string }): Promise<{ id: string; url: string }>;
  revoke(id: string): Promise<void>;
}

export const NO_HUB = 'Inviting guests needs the tray hub.';
export const NO_CONTROL = 'Only a tab with Control can invite guests.';
export const NO_OWNER = "Only the owner's tab can invite guests.";

export class GuestAdapter extends Emitter<GuestEvents> implements GuestPort {
  readonly #connection: AgentConnection;
  readonly #hub: GuestHub | null;

  constructor(connection: AgentConnection, hub: GuestHub | null) {
    super();
    this.#connection = connection;
    this.#hub = hub;
    connection.guests?.subscribe(() => this.emit('seats', this.list()));
  }

  list(): readonly GuestSeat[] {
    return this.#connection.guests?.value ?? [];
  }

  unavailable(): string | null {
    const connection = this.#connection;
    if (connection.mismatch || connection.viewOnly || connection.guest || !connection.guests)
      return NO_CONTROL;
    if (connection.owner === false) return NO_OWNER;
    return this.#hub ? null : NO_HUB;
  }

  async mint(agentId: string, draft: GuestDraft): Promise<{ seat: GuestSeat; url: string }> {
    const problem = this.unavailable();
    if (problem) throw new Error(problem);
    const hub = this.#hub as GuestHub;
    const gates = { messages: draft.gates.messages, tools: draft.gates.tools };
    const minted = await hub.mint({
      label: draft.label,
      expiresAt: draft.expiresAt,
      gates,
      agentId,
    });
    const opened = await this.#connection.control
      .guestOpen(
        { id: minted.id, label: draft.label, agentId, expiresAt: draft.expiresAt, gates },
        BACKGROUND_CONTEXT
      )
      .catch((error: Error) => ({ seat: null, error: error.message }));
    if (!opened.seat) {
      await hub.revoke(minted.id).catch(() => undefined);
      throw new Error(opened.error);
    }
    return { seat: opened.seat, url: minted.url };
  }

  async revoke(id: string): Promise<void> {
    await this.#connection.control.guestRevoke(id, BACKGROUND_CONTEXT);
    await this.#hub?.revoke(id);
  }
}

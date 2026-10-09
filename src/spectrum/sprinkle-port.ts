import type { Sprinkle, SprinkleEvents, SprinklePort } from '@ai-ecoverse/slicc-spectrum/ui';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import { Emitter } from './emitter.ts';

type Payload = { action?: unknown; data?: unknown; target?: unknown } | null;

export class SprinkleAdapter extends Emitter<SprinkleEvents> implements SprinklePort {
  readonly #connection: AgentConnection;

  constructor(connection: AgentConnection) {
    super();
    this.#connection = connection;
    connection.sprinkles?.subscribe(() => this.emit('sprinkles', this.list()));
  }

  list(): readonly Sprinkle[] {
    return this.#connection.sprinkles?.value ?? [];
  }

  send(id: string, payload: unknown): void {
    const value = (payload ?? null) as Payload;
    void this.#connection.control.sprinkleSend(
      id,
      {
        action: String(value?.action ?? ''),
        data: (value?.data ?? null) as JsonValue | null,
        target: typeof value?.target === 'string' ? value.target : null,
      },
      BACKGROUND_CONTEXT
    );
  }

  call(id: string, method: string, args: readonly unknown[]): Promise<unknown> {
    return this.#connection.control.sprinkleCall(
      id,
      method,
      args as JsonValue[],
      BACKGROUND_CONTEXT
    );
  }
}

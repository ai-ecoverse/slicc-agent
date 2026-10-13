import type { Sprinkle, SprinkleEvents, SprinklePort } from '@ai-ecoverse/slicc-spectrum/ui';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentConnection } from '../client.ts';
import { attempt, type Report, warn } from './attempt.ts';
import { Emitter } from './emitter.ts';

type Payload = { action?: unknown; data?: unknown; target?: unknown } | null;

export class SprinkleAdapter extends Emitter<SprinkleEvents> implements SprinklePort {
  readonly #connection: AgentConnection;
  readonly #report: Report;

  constructor(connection: AgentConnection, report: Report = warn) {
    super();
    this.#connection = connection;
    this.#report = report;
    connection.sprinkles?.subscribe(() => this.emit('sprinkles', this.list()));
  }

  list(): readonly Sprinkle[] {
    return this.#connection.sprinkles?.value ?? [];
  }

  send(id: string, payload: unknown): void {
    const value = (payload ?? null) as Payload;
    attempt(
      this.#connection.control.sprinkleSend(
        id,
        {
          action: String(value?.action ?? ''),
          data: (value?.data ?? null) as JsonValue | null,
          target: typeof value?.target === 'string' ? value.target : null,
        },
        BACKGROUND_CONTEXT
      ),
      'send sprinkle actions',
      this.#report
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

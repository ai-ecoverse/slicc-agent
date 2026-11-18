import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { type Draft, track } from '@earendil-works/chord/delta';

export type Listener<T> = (value: T, context: Context) => unknown;

export interface State<T> {
  readonly value: T;
  subscribe(listener: Listener<T>): () => void;
}

export interface MutableState<T extends object> extends State<T> {
  replace(context: Context, value: T): void;
  change(context: Context, mutate: (draft: Draft<T>) => void): void;
}

const PENDING = 100;

const report = (error: unknown) =>
  queueMicrotask(() => {
    throw error;
  });

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

class Subscriber<T> {
  readonly #listener: Listener<T>;
  readonly #pending: { value: T; context: Context }[] = [];
  #running = false;
  #closed = false;

  constructor(listener: Listener<T>) {
    this.#listener = listener;
  }

  push(value: T, context: Context): void {
    if (this.#closed) return;
    if (this.#pending.length === PENDING) this.#pending.length = 0;
    this.#pending.push({ value, context });
    this.#drain();
  }

  close(): void {
    this.#closed = true;
    this.#pending.length = 0;
  }

  #drain(): void {
    if (this.#running || this.#closed) return;
    this.#running = true;
    for (let next = this.#pending.shift(); next; next = this.#pending.shift()) {
      try {
        const result = this.#listener(next.value, next.context);
        if (thenable(result)) {
          Promise.resolve(result).then(
            () => this.#resume(),
            (error: unknown) => {
              report(error);
              this.#resume();
            }
          );
          return;
        }
      } catch (error) {
        report(error);
      }
    }
    this.#running = false;
  }

  #resume(): void {
    this.#running = false;
    this.#drain();
  }
}

export function createState<T extends object>(initial: T): MutableState<T> {
  const tracker = track(initial);
  const subscribers = new Set<Subscriber<T>>();
  const publish = (context: Context) => {
    const value = tracker.value;
    for (const subscriber of [...subscribers]) subscriber.push(value, context);
  };
  return {
    get value() {
      return tracker.value;
    },
    subscribe(listener) {
      const subscriber = new Subscriber(listener);
      subscribers.add(subscriber);
      subscriber.push(tracker.value, BACKGROUND_CONTEXT);
      return () => {
        subscriber.close();
        subscribers.delete(subscriber);
      };
    },
    replace(context, value) {
      const prepared = tracker.prepareReplace(value);
      tracker.adopt(prepared);
      if (prepared.ops.length > 0) publish(context);
    },
    change(context, mutate) {
      const change = tracker.beginChange();
      let prepared: ReturnType<typeof change.prepare>;
      try {
        mutate(change.state);
        prepared = change.prepare();
      } catch (error) {
        change.abort();
        throw error;
      }
      tracker.adopt(prepared);
      if (prepared.ops.length > 0) publish(context);
    },
  };
}

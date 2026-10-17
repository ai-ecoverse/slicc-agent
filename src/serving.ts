import {
  type Ctx,
  hostNamed,
  isChordError,
  method,
  type Readable,
  type RemoteContract,
  type ReplicatedState,
  remote,
  type StateEvent,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from '@earendil-works/chord/context';
import { diffRevisions } from '@earendil-works/chord/delta';
import { Type } from 'typebox';

export const AGENT_HOST = 'agent';

export type Seat = 'owner' | 'control' | 'view' | 'guest';

export interface GuestPrincipal {
  id: string;
  name: string;
  epoch: number;
}

export type AgentPrincipal =
  | { seat: 'owner' | 'control' | 'view'; link: number; device?: string }
  | { seat: 'guest'; link: number; guest: GuestPrincipal }
  | { seat: 'host' };

export const SELF: AgentPrincipal = { seat: 'host' };

export const principalKey = (principal: AgentPrincipal): string => {
  if (principal.seat === 'host') return 'host';
  if (principal.seat === 'guest') {
    const { guest, link } = principal;
    return `guest:${guest.id}:e${guest.epoch}:${link}`;
  }
  return `${principal.seat}:${principal.link}`;
};

export interface Members {
  methods?: readonly string[];
  state?: readonly string[];
}

const Args = Type.Array(Type.Unknown());
const Value = Type.Unknown();

export function contract(name: string, variants: Record<string, Members>): RemoteContract {
  const def: Parameters<typeof remote>[1] = {
    version: 1,
    input: Type.Object({}),
    host: hostNamed(AGENT_HOST),
    variants: Object.fromEntries(
      Object.entries(variants).map(([kind, members]) => [
        kind,
        {
          state: Object.fromEntries((members.state ?? []).map((member) => [member, Value])),
          methods: Object.fromEntries(
            (members.methods ?? []).map((member) => [member, method(Args, Value)])
          ),
        },
      ])
    ),
  };
  return remote(name, def);
}

export type Callable = (...args: unknown[]) => Promise<unknown>;

export const contextOf = (ctx: Ctx): Context => withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);

export function served(
  impl: () => object,
  names: readonly string[]
): Record<string, (args: unknown[], ctx: Ctx) => Promise<unknown>> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (args: unknown[], ctx: Ctx) =>
        ((impl() as Record<string, Callable>)[name] as Callable)(...args, contextOf(ctx)),
    ])
  );
}

const readables = new WeakMap<object, Readable<unknown>>();

export function readable<T>(state: ReplicatedState<T>): Readable<T> {
  const known = readables.get(state);
  if (known) return known as Readable<T>;
  const values = new Set<(value: T) => void>();
  const events = new Set<(event: StateEvent<T>) => void>();
  let value = state.value as T;
  let off: (() => void) | undefined;
  const start = () => {
    if (off) return;
    value = state.value as T;
    off = state.subscribe((next) => {
      const before = value;
      value = next;
      if (before === next) return;
      const event: StateEvent<T> =
        before === undefined
          ? { type: 'reset', value: next }
          : { type: 'ops', ops: diffRevisions(before as never, next as never), value: next };
      for (const listener of [...events]) listener(event);
      for (const listener of [...values]) listener(next);
    });
  };
  const stop = () => {
    if (values.size + events.size > 0 || !off) return;
    off();
    off = undefined;
  };
  const made: Readable<T> = {
    get value() {
      return off ? value : (state.value as T);
    },
    subscribe(listener) {
      values.add(listener);
      start();
      listener(value);
      return () => {
        values.delete(listener);
        stop();
      };
    },
    events(listener) {
      events.add(listener);
      start();
      listener({ type: 'snap', value });
      return () => {
        events.delete(listener);
        stop();
      };
    },
  };
  readables.set(state, made);
  return made;
}

export function readablesOf(
  states: Record<string, ReplicatedState<unknown>>
): Record<string, Readable<unknown>> {
  return Object.fromEntries(Object.entries(states).map(([name, state]) => [name, readable(state)]));
}

export interface Remote {
  readonly variant: string | undefined;
  readonly ready: Promise<void>;
  release(): void;
  [member: string]: unknown;
}

export function replicated<T>(member: Readable<T>): ReplicatedState<T> {
  return {
    get value() {
      return member.value;
    },
    subscribe(listener: (value: T, context: Context, delivery: never) => unknown) {
      let sequence = 0;
      return member.subscribe((value) => {
        sequence += 1;
        void listener(value, BACKGROUND_CONTEXT, {
          kind: sequence === 1 ? 'hydrate' : 'update',
          sequence,
        } as never);
      });
    },
  } as ReplicatedState<T>;
}

export const CLOSED = 'the connection to the agent is closed';

export function plain(error: unknown): unknown {
  if (!isChordError(error)) return error;
  if (error.code === 'released') return Object.assign(new Error(CLOSED), { code: 'released' });
  const prefix = error.reason ? `${error.code}/${error.reason}: ` : `${error.code}: `;
  const message = error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : error.message;
  return Object.assign(new Error(message), { code: error.code });
}

const isContext = (value: unknown): value is Context =>
  typeof value === 'object' &&
  value !== null &&
  'abortSignal' in value &&
  typeof (value as Context).value === 'function';

export type Root = <R>(
  run: (ctx: Ctx) => Promise<R>,
  options: { signal?: AbortSignal }
) => Promise<R>;

export function bound<T extends object>(
  handle: Remote,
  root: Root,
  names: readonly string[],
  absent: (name: string) => Callable
): T {
  const shape = (handle as { shape?: { members: readonly string[] } }).shape;
  const members = new Set(shape?.members ?? []);
  return Object.fromEntries(
    names.map((name) => {
      if (!members.has(name)) return [name, absent(name)];
      const call = handle[name] as (args: unknown[], ctx: Ctx) => Promise<unknown>;
      return [
        name,
        async (...given: unknown[]) => {
          const last = given.at(-1);
          const context = isContext(last) ? last : undefined;
          const args = context ? given.slice(0, -1) : given;
          const signal = context?.abortSignal;
          try {
            return await root((ctx) => call(args, ctx), signal ? { signal } : {});
          } catch (error) {
            throw plain(error);
          }
        },
      ];
    })
  ) as T;
}

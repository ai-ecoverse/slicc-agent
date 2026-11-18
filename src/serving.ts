import {
  arr,
  type Contract,
  type Ctx,
  type FollowAttach,
  hostKind,
  isChordError,
  method,
  PluginError,
  remote,
  unknown,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from '@earendil-works/chord/context';
import { diffRevisions } from '@earendil-works/chord/delta';
import type { JsonValue } from '@earendil-works/chord/json';
import type { WatchHandle } from '@earendil-works/chord/watch';
import { createState, type MutableState, type State } from './state.ts';

export const AGENT_HOST = 'slicc-agent';

export const Agent = hostKind(AGENT_HOST);

export type Seat = 'owner' | 'control' | 'view' | 'guest';

export type GuestPrincipal = {
  id: string;
  name: string;
  epoch: number;
};

export type AgentPrincipal =
  | { kind: 'owner' | 'control' | 'view'; link: number; device?: string }
  | { kind: 'guest'; link: number; guest: GuestPrincipal }
  | { kind: 'host' };

export const SELF: AgentPrincipal = { kind: 'host' };

export const principalKey = (principal: AgentPrincipal): string => {
  if (principal.kind === 'host') return 'host';
  if (principal.kind === 'guest') {
    const { guest, link } = principal;
    return `guest:${guest.id}:e${guest.epoch}:${link}`;
  }
  return `${principal.kind}:${principal.link}`;
};

export interface Members {
  methods?: readonly string[];
  state?: readonly string[];
}

export type Variants = Record<string, Members>;

const Args = arr(unknown());
const Value = unknown();

const shapes = new WeakMap<Contract, Variants>();

export function contract(name: string, variants: Variants): Contract {
  const made = remote(name, {
    version: 1,
    params: {},
    hostAddress: () => Agent(),
    variants: Object.fromEntries(
      Object.entries(variants).map(([variant, members]) => [
        variant,
        {
          state: Object.fromEntries((members.state ?? []).map((member) => [member, Value])),
          methods: Object.fromEntries(
            (members.methods ?? []).map((member) => [member, method(Args, Value)])
          ),
        },
      ])
    ),
  } as never) as Contract;
  shapes.set(made, variants);
  return made;
}

export const fingerprints = (contracts: readonly Contract[]): string =>
  contracts
    .map((made) => `${made.name}@${made.fingerprint}`)
    .sort()
    .join(' ');

export type Callable = (...args: unknown[]) => Promise<unknown>;

export const contextOf = (ctx: Ctx): Context =>
  ctx.abortSignal ? withAbortSignal(ctx.abortSignal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

const coded = (error: unknown): unknown => {
  if (isChordError(error) || error instanceof PluginError || !(error instanceof Error))
    return error;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? new PluginError(code, error.message) : error;
};

export type Served = Record<string, (args: unknown[], ctx: Ctx) => Promise<unknown>>;

export function served(impl: () => object, names: readonly string[]): Served {
  return Object.fromEntries(
    names.map((name) => [
      name,
      async (args: unknown[], ctx: Ctx) => {
        try {
          return await ((impl() as Record<string, Callable>)[name] as Callable)(
            ...args,
            contextOf(ctx)
          );
        } catch (error) {
          throw coded(error);
        }
      },
    ])
  );
}

type Observer = Parameters<FollowAttach<unknown>>[0];

interface Fanout {
  last: unknown;
  readonly observers: Set<Observer>;
  off: () => void;
}

const fanouts = new WeakMap<State<unknown>, Fanout>();

function fanoutOf(state: State<unknown>): Fanout {
  const known = fanouts.get(state);
  if (known) return known;
  const made: Fanout = { last: state.value, observers: new Set(), off: () => undefined };
  made.off = state.subscribe((next, context) => {
    if (next === made.last) return;
    const ops = diffRevisions(made.last as JsonValue, next as JsonValue);
    made.last = next;
    for (const observer of [...made.observers])
      observer.advance({ kind: 'value', value: next, ops, retired: false }, context);
  });
  fanouts.set(state, made);
  return made;
}

export function following<T>(source: () => State<T>): FollowAttach<T> {
  return async (observer) => {
    const state = source() as State<unknown>;
    const fanout = fanoutOf(state);
    fanout.observers.add(observer);
    return {
      value: fanout.last as T,
      detach() {
        fanout.observers.delete(observer);
        if (fanout.observers.size > 0 || fanouts.get(state) !== fanout) return;
        fanouts.delete(state);
        fanout.off();
      },
    };
  };
}

export interface Remote {
  readonly variant: string | undefined;
  release(): void;
  [member: string]: unknown;
}

export function offers(contract: Contract, variant: string | undefined, name: string): boolean {
  const members = variant === undefined ? undefined : shapes.get(contract)?.[variant];
  return members?.methods?.includes(name) ?? false;
}

export interface Replica<T> {
  readonly state: State<T>;
  stop(): void;
}

export function replica<T extends object>(
  member: { readonly value: T; watch(context: Context): Promise<WatchHandle<T>> },
  context: Context
): Replica<T> {
  const local: MutableState<T> = createState(member.value);
  let stopped = false;
  let watch: WatchHandle<T> | undefined;
  member.watch(context).then(
    (made) => {
      watch = made;
      if (stopped) {
        void made.stop();
        return;
      }
      made.start(async (call, using) => {
        if (call.kind === 'value') local.replace(using, call.value);
      });
    },
    () => undefined
  );
  const view: State<T> = {
    get value() {
      return local.value;
    },
    subscribe: (listener) => local.subscribe(listener),
  };
  return {
    state: view,
    stop() {
      stopped = true;
      void watch?.stop();
    },
  };
}

export const CLOSED = 'the connection to the agent is closed';

export function plain(error: unknown): unknown {
  if (error instanceof PluginError) {
    const made = new Error(error.message);
    return error.code === 'internal' ? made : Object.assign(made, { code: error.code });
  }
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

export function bound<T extends object>(
  contract: Contract,
  handle: Remote,
  names: readonly string[],
  absent: (name: string) => Callable
): T {
  return Object.fromEntries(
    names.map((name) => {
      if (!offers(contract, handle.variant, name)) return [name, absent(name)];
      const call = handle[name] as (args: unknown[], context: Context) => Promise<unknown>;
      return [
        name,
        async (...given: unknown[]) => {
          const last = given.at(-1);
          const context = isContext(last) ? last : BACKGROUND_CONTEXT;
          const args = isContext(last) ? given.slice(0, -1) : given;
          try {
            return await call(args, context);
          } catch (error) {
            throw plain(error);
          }
        },
      ];
    })
  ) as T;
}

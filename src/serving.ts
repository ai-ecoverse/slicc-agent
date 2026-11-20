import {
  type AcceptsTable,
  arr,
  type Contract,
  type Ctx,
  evolve,
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
import { otherService } from './wire.ts';

export const AGENT_HOST = 'slicc-agent';

export const Agent = hostKind(AGENT_HOST);

export type Seat = 'owner' | 'control' | 'view' | 'guest';

export type GuestPrincipal = {
  id: string;
  name: string;
  epoch: number;
};

export type LinkCalls = { running: number; readonly max: number };

export type AgentPrincipal =
  | { kind: 'owner' | 'control' | 'view'; link: number; device?: string }
  | { kind: 'guest'; link: number; guest: GuestPrincipal; calls: LinkCalls }
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

export interface History {
  since?: number;
  added?: Readonly<Record<number, readonly string[]>>;
}

const Args = arr(unknown());
const Value = unknown();

const shapes = new WeakMap<Contract, Variants>();
const histories = new WeakMap<Contract, readonly Contract[]>();

interface Editor {
  addMethod(variant: string, member: string, args: unknown, result: unknown): Editor;
  addState(variant: string, member: string, schema: unknown): Editor;
}

const evolved = evolve as unknown as (
  previous: Contract,
  edit: (editor: Editor) => Editor
) => Contract;

const without = (variants: Variants, later: ReadonlySet<string>): Variants =>
  Object.fromEntries(
    Object.entries(variants).map(([variant, members]) => [
      variant,
      {
        state: (members.state ?? []).filter((member) => !later.has(member)),
        methods: (members.methods ?? []).filter((member) => !later.has(member)),
      },
    ])
  );

function steps(name: string, variants: Variants, since: number, history: History) {
  const added = Object.entries(history.added ?? {})
    .map(([version, members]) => [Number(version), members] as const)
    .sort(([one], [other]) => one - other);
  const known = new Set(
    Object.values(variants).flatMap((members) => [
      ...(members.methods ?? []),
      ...(members.state ?? []),
    ])
  );
  const seen = new Set<string>();
  added.forEach(([version, members], index) => {
    if (version !== since + index + 1)
      throw new Error(`${name}: added versions must follow v${since} one by one`);
    for (const member of members) {
      if (!known.has(member) || seen.has(member))
        throw new Error(`${name} v${version}: ${member} is not a new member of a variant`);
      seen.add(member);
    }
  });
  return { added, later: seen };
}

export function contract(name: string, variants: Variants, history: History = {}): Contract {
  const since = history.since ?? 1;
  const { added, later } = steps(name, variants, since, history);
  const pending = new Set(later);
  const base = without(variants, pending);
  let made = remote(name, {
    version: since,
    params: {},
    hostAddress: () => Agent(),
    variants: Object.fromEntries(
      Object.entries(base).map(([variant, members]) => [
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
  shapes.set(made, base);
  const chain = [made];
  for (const [, members] of added) {
    made = evolved(made, (editor) => {
      for (const member of members)
        for (const [variant, shape] of Object.entries(variants)) {
          if (shape.methods?.includes(member)) editor.addMethod(variant, member, Args, Value);
          if (shape.state?.includes(member)) editor.addState(variant, member, Value);
        }
      return editor;
    });
    for (const member of members) pending.delete(member);
    shapes.set(made, without(variants, pending));
    chain.push(made);
  }
  histories.set(made, chain);
  return made;
}

export const variantsOf = (made: Contract): Variants | undefined => shapes.get(made);

export const historyOf = (made: Contract): readonly Contract[] => histories.get(made) ?? [made];

export const acceptsOf = (made: Contract): AcceptsTable<Contract> =>
  Object.fromEntries(
    historyOf(made)
      .slice(0, -1)
      .map((older) => [older.version, {}])
  );

export const serviceOf = (made: Contract): string =>
  made.name.slice(made.name.lastIndexOf('.') + 1);

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
  readonly refused?: Error;
  release(): void;
  [member: string]: unknown;
}

const boundAt = new WeakMap<Remote, Contract>();

export const bindAt = (handle: Remote, made: Contract): Remote => {
  boundAt.set(handle, made);
  return handle;
};

const membersOf = (made: Contract | undefined, variant: string | undefined): readonly string[] => {
  const shape = made && variant !== undefined ? shapes.get(made)?.[variant] : undefined;
  return [...(shape?.methods ?? []), ...(shape?.state ?? [])];
};

export const offers = (handle: Remote, name: string): boolean =>
  membersOf(boundAt.get(handle), handle.variant).includes(name);

const lacking = (handle: Remote, name: string): Error | undefined => {
  if (handle.refused) return handle.refused;
  const made = boundAt.get(handle);
  if (!made) return undefined;
  const variants = Object.keys(shapes.get(made) ?? {});
  return variants.some((variant) => membersOf(made, variant).includes(name))
    ? undefined
    : otherService(serviceOf(made));
};

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
  handle: Remote,
  names: readonly string[],
  absent: (name: string) => Callable
): T {
  return Object.fromEntries(
    names.map((name) => {
      const refused = lacking(handle, name);
      if (refused) return [name, () => Promise.reject(refused)];
      if (!offers(handle, name)) return [name, absent(name)];
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

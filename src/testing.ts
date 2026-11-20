import { binaryCodec, type Message } from '@earendil-works/chord';
import { CONTRACTS, helloOf } from './services.ts';
import { AGENT_HOST, historyOf, type Variants, variantsOf } from './serving.ts';
import { CHORD_PROTOCOL, type Frame, type Hello, type PortEndpoint } from './wire.ts';

export type { Hello, PortEndpoint } from './wire.ts';

export type RawMessage = { readonly kind: string; readonly [field: string]: unknown };

export type RawService =
  | 'control'
  | 'transcript'
  | 'settings'
  | 'remote'
  | 'pages'
  | 'guest'
  | 'inventory'
  | 'sudo';

export type RawAnswer = { value: unknown } | { error: { code: string; message: string } };

export interface RawHold {
  readonly hold: number;
  readonly variant: string | null;
  readonly methods: readonly string[];
  readonly error: { code: string; message: string } | null;
  call(method: string, args?: unknown[]): Promise<RawAnswer>;
  callAt(index: number, args?: unknown[]): Promise<RawAnswer>;
  release(): void;
}

export interface RawLink {
  readonly hello: Hello;
  readonly received: readonly RawMessage[];
  readonly closed: Promise<{ reason: string | null }>;
  send(message: RawMessage): void;
  ack(): void;
  post(frame: unknown): void;
  next(match: (message: RawMessage) => boolean, ms?: number): Promise<RawMessage>;
  hold(
    service: RawService,
    options?: { principal?: { kind: string }; version?: number }
  ): Promise<RawHold>;
  close(): void;
}

export interface RawOptions {
  hello?: Partial<Hello>;
  ms?: number;
  acks?: boolean;
}

export class RawRefused extends Error {
  readonly reason: string | null;

  constructor(reason: string | null) {
    super(`the agent closed the raw link${reason ? `: ${reason}` : ''}`);
    this.reason = reason;
  }
}

const MS = 5000;
const decoder = new TextDecoder();

export const partText = (part: unknown): string =>
  part instanceof Uint8Array ? decoder.decode(part) : typeof part === 'string' ? part : 'null';

const contractOf = (service: RawService, version?: number) => {
  const found = CONTRACTS.find((made) => made.name === `slicc.agent.${service}`);
  if (!found) throw new Error(`no service ${service}`);
  const held = historyOf(found).find((made) => made.version === (version ?? found.version));
  if (!held) throw new Error(`no version ${version} of ${service}`);
  return held;
};

type WireError =
  | { kind: 'chord'; error: unknown }
  | { kind: 'plugin'; code: string; message: string };

const errorOf = (wire: WireError): { code: string; message: string } => {
  const raw = (wire.kind === 'chord' ? wire.error : wire) as { code?: unknown; message?: unknown };
  return { code: String(raw.code), message: String(raw.message) };
};

function holdsOf(message: RawMessage): readonly { hold: number; variant: number }[] {
  return message.kind === 'bound' ? (message.holds as { hold: number; variant: number }[]) : [];
}

export async function openRawLink(
  endpoint: PortEndpoint,
  options: RawOptions = {}
): Promise<RawLink> {
  const ms = options.ms ?? MS;
  const acks = options.acks ?? true;
  const received: RawMessage[] = [];
  const waiting = new Set<{
    match: (message: RawMessage) => boolean;
    found: (message: RawMessage) => void;
  }>();
  let welcome!: (greeting: { hello: Hello }) => void;
  let finish!: (end: { reason: string | null }) => void;
  const greeted = new Promise<{ hello: Hello }>((resolve) => {
    welcome = resolve;
  });
  const closed = new Promise<{ reason: string | null }>((resolve) => {
    finish = (end) => {
      endpoint.close?.();
      resolve(end);
    };
  });
  const send = (message: RawMessage) => {
    const bytes = binaryCodec.encode(message as unknown as Message);
    endpoint.postMessage(bytes, [bytes.buffer as ArrayBuffer]);
  };
  endpoint.addEventListener('message', ({ data }) => {
    const frame = data as Frame;
    if (frame instanceof Uint8Array) {
      const message = binaryCodec.decode(frame) as unknown as RawMessage;
      received.push(message);
      if (message.kind === 'ping') send({ kind: 'pong' });
      if (acks && (message.kind === 'bound' || message.kind === 'state')) send({ kind: 'ack' });
      for (const wait of [...waiting]) if (wait.match(message)) wait.found(message);
    } else if ('hello' in frame) {
      welcome({ hello: frame.hello as Hello });
    } else {
      finish({ reason: frame.reason ?? null });
    }
  });
  endpoint.addEventListener('close', () => finish({ reason: null }));
  endpoint.start?.();
  const next = (match: (message: RawMessage) => boolean, wait = ms) => {
    const seen = received.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise<RawMessage>((resolve, reject) => {
      const entry = {
        match,
        found: (message: RawMessage) => {
          waiting.delete(entry);
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        waiting.delete(entry);
        reject(new Error(`no matching message within ${wait} ms`));
      }, wait);
      waiting.add(entry);
      void closed.then(({ reason }) => {
        if (!waiting.delete(entry)) return;
        clearTimeout(timer);
        reject(new RawRefused(reason));
      });
    });
  };
  endpoint.postMessage({ hello: { ...helloOf(), ...options.hello } });
  const first = await Promise.race([greeted, closed]);
  if (!('hello' in first)) throw new RawRefused(first.reason);
  send({ kind: 'hello', protocol: CHORD_PROTOCOL, incarnation: crypto.randomUUID(), calls: 16 });
  await next((message) => message.kind === 'hello');
  let holds = 0;
  let calls = 0;
  const answer = async (hold: number, method: number, args: unknown[]): Promise<RawAnswer> => {
    const call = calls++;
    send({ kind: 'call', call, hold, method, args: JSON.stringify(args) });
    const reply = await next(
      (message) => (message.kind === 'result' || message.kind === 'error') && message.call === call
    );
    return reply.kind === 'result'
      ? { value: JSON.parse(partText(reply.value)) }
      : { error: errorOf(reply.error as WireError) };
  };
  return {
    hello: first.hello,
    received,
    closed,
    send,
    ack: () => send({ kind: 'ack' }),
    post: (frame) => endpoint.postMessage(frame),
    next,
    async hold(service, holding = {}) {
      const contract = contractOf(service, holding.version);
      const hold = holds++;
      send({
        kind: 'hold',
        hold,
        type: contract.name,
        version: contract.version,
        fingerprint: contract.fingerprint,
        params: '{}',
        address: { kind: AGENT_HOST, params: {} },
        ...(holding.principal ? { principal: holding.principal } : {}),
      });
      const reply = await next(
        (message) =>
          holdsOf(message).some((entry) => entry.hold === hold) ||
          ((message.kind === 'failed' || message.kind === 'gone') && message.hold === hold)
      );
      const variants = variantsOf(contract) as Variants;
      const bound = holdsOf(reply).find((entry) => entry.hold === hold);
      const variant = bound ? (Object.keys(variants).sort()[bound.variant] as string) : null;
      const methods = variant ? [...(variants[variant]?.methods ?? [])].sort() : [];
      const failure =
        reply.kind === 'failed'
          ? (reply.cause as { error: WireError }).error
          : reply.kind === 'gone'
            ? (reply.error as WireError)
            : undefined;
      return {
        hold,
        variant,
        methods,
        error: failure ? errorOf(failure) : null,
        call(method, args = []) {
          const index = methods.indexOf(method);
          if (index < 0) throw new Error(`${service} ${variant} has no method ${method}`);
          return answer(hold, index, args);
        },
        callAt: (index, args = []) => answer(hold, index, args),
        release: () => send({ kind: 'release', hold }),
      };
    },
    close() {
      endpoint.postMessage({ close: true });
      finish({ reason: null });
    },
  };
}

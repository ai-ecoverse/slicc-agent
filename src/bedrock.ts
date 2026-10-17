import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Provider,
  ProviderStreams,
} from '@earendil-works/pi-ai';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import { BEDROCK_ABORT_PATCH } from './patches.ts';
import { BEDROCK } from './preferred.ts';

const patched = Symbol.for('slicc.agent.bedrock-abort');
const DROPS = /this\.httpHandler\.handle\(\w+\)/;
const ANSWERED = new Set(['stop', 'length', 'toolUse']);

export const UNPATCHED_COPY = `${BEDROCK_ABORT_PATCH}: Bedrock answered through a WebSocketFetchHandler the agent didn't patch, so Stop can't cancel its requests; the agent and @aws-sdk/client-bedrock-runtime load different copies of @aws-sdk/middleware-websocket`;

export interface Probe {
  sent: number;
}

interface HttpRequest {
  protocol?: string;
}

interface Handle {
  handle(request: HttpRequest, options?: unknown): Promise<unknown>;
}

interface WebSocketHandler extends Handle {
  config: unknown;
  configPromise: Promise<unknown>;
  httpHandler: Handle;
}

export function patchWebSocketHandler(target: { prototype: object }): Probe {
  const proto = target.prototype as WebSocketHandler & { [patched]?: Probe };
  const done = proto[patched];
  if (done) return done;
  const original = proto.handle;
  if (typeof original !== 'function' || !DROPS.test(String(original))) {
    throw new Error(
      `${BEDROCK_ABORT_PATCH}: WebSocketFetchHandler.prototype.handle no longer calls this.httpHandler.handle(request); revisit patches.json`
    );
  }
  const probe: Probe = { sent: 0 };
  proto.handle = async function handle(request, options) {
    if (request.protocol === 'ws:' || request.protocol === 'wss:')
      return original.call(this, request, options);
    probe.sent += 1;
    this.config = await this.configPromise;
    return this.httpHandler.handle(request, options);
  };
  proto[patched] = probe;
  return probe;
}

let loading: Promise<Probe> | undefined;

export function patchBedrockAbort(
  load: () => Promise<{ WebSocketFetchHandler: { prototype: object } }> = () =>
    import('@aws-sdk/middleware-websocket')
): Promise<Probe> {
  loading ??= load().then(
    ({ WebSocketFetchHandler }) => patchWebSocketHandler(WebSocketFetchHandler),
    (error: unknown) => {
      loading = undefined;
      throw error;
    }
  );
  return loading;
}

export function abortableBedrock(
  provider: Provider,
  patch: () => Promise<Probe> = patchBedrockAbort,
  warn: (message: string) => void = (message) => console.warn(message)
): Provider {
  if (provider.id !== BEDROCK) return provider;
  let warned = false;
  const checked = (stream: AssistantMessageEventStream, probe: Probe) => ({
    [Symbol.asyncIterator]: (): AsyncIterator<AssistantMessageEvent> =>
      stream[Symbol.asyncIterator](),
    async result(): Promise<AssistantMessage> {
      const message = await stream.result();
      if (!warned && probe.sent === 0 && ANSWERED.has(message.stopReason)) {
        warned = true;
        warn(UNPATCHED_COPY);
      }
      return message;
    },
  });
  const streams: Pick<ProviderStreams, 'stream' | 'streamSimple'> = {
    stream: (model, context, options) =>
      lazyStream(model, async () => {
        const probe = await patch();
        return checked(provider.stream(model, context, options), probe);
      }),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () => {
        const probe = await patch();
        return checked(provider.streamSimple(model, context, options), probe);
      }),
  };
  return { ...provider, ...streams };
}

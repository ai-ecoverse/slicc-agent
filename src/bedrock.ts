import type { Provider, ProviderStreams } from '@earendil-works/pi-ai';
import { lazyStream } from '@earendil-works/pi-ai/api/lazy';
import { BEDROCK_ABORT_PATCH } from './patches.ts';
import { BEDROCK } from './preferred.ts';

const patched = Symbol.for('slicc.agent.bedrock-abort');
const DROPS = /this\.httpHandler\.handle\(\w+\)/;

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

export function patchWebSocketHandler(target: { prototype: object }): void {
  const proto = target.prototype as WebSocketHandler & { [patched]?: true };
  if (proto[patched]) return;
  const original = proto.handle;
  if (typeof original !== 'function' || !DROPS.test(String(original))) {
    throw new Error(
      `${BEDROCK_ABORT_PATCH}: WebSocketFetchHandler.prototype.handle no longer calls this.httpHandler.handle(request); revisit patches.json`
    );
  }
  proto.handle = async function handle(request, options) {
    if (request.protocol === 'ws:' || request.protocol === 'wss:')
      return original.call(this, request, options);
    this.config = await this.configPromise;
    return this.httpHandler.handle(request, options);
  };
  proto[patched] = true;
}

let loading: Promise<void> | undefined;

export function patchBedrockAbort(
  load: () => Promise<{ WebSocketFetchHandler: { prototype: object } }> = () =>
    import('@aws-sdk/middleware-websocket')
): Promise<void> {
  loading ??= load().then(({ WebSocketFetchHandler }) =>
    patchWebSocketHandler(WebSocketFetchHandler)
  );
  return loading;
}

export function abortableBedrock(provider: Provider, patch = patchBedrockAbort): Provider {
  if (provider.id !== BEDROCK) return provider;
  const streams: Pick<ProviderStreams, 'stream' | 'streamSimple'> = {
    stream: (model, context, options) =>
      lazyStream(model, async () => {
        await patch();
        return provider.stream(model, context, options);
      }),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () => {
        await patch();
        return provider.streamSimple(model, context, options);
      }),
  };
  return { ...provider, ...streams };
}

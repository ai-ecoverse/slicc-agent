import type {
  SpanAttributes,
  SpanOptions,
  TelemetryContext,
  TelemetrySpan,
} from '@earendil-works/pi-telemetry';

export const TIMINGS_MAX = 50;
const REQUEST = 'pi.ai.request';
const FIRST_CHUNK = 'pi.ai.first_chunk';

export interface ModelTiming {
  at: number;
  provider: string;
  model: string;
  stop: string;
  durationMs: number;
  firstChunkMs: number | null;
}

export interface Timings {
  list(): readonly ModelTiming[];
  subscribe(listener: (timing: ModelTiming) => void): () => void;
}

export interface TimingSink extends Timings {
  readonly telemetry: TelemetryContext;
}

const text = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

export interface TimingsOptions {
  clock?: () => number;
  wall?: () => number;
  max?: number;
  onError?: (error: unknown) => void;
}

export function createTimings({
  clock = () => performance.now(),
  wall = Date.now,
  max = TIMINGS_MAX,
  onError = () => undefined,
}: TimingsOptions = {}): TimingSink {
  const kept: ModelTiming[] = [];
  const listeners = new Set<(timing: ModelTiming) => void>();
  const record = (timing: ModelTiming) => {
    kept.unshift(timing);
    kept.length = Math.min(kept.length, max);
    for (const listener of listeners)
      try {
        listener(timing);
      } catch (error) {
        onError(error);
      }
  };
  const start = async <T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>
  ): Promise<T> => {
    const started = clock();
    const attributes: SpanAttributes = { ...options.attributes };
    let firstChunk: number | null = null;
    const span: TelemetrySpan = {
      startSpan: start,
      addLink: () => undefined,
      addEvent: (name) => {
        if (name === FIRST_CHUNK && firstChunk === null) firstChunk = clock() - started;
      },
      setAttributes: (more) => {
        Object.assign(attributes, more);
      },
      setStatus: () => undefined,
    };
    try {
      return await callback(span);
    } finally {
      if (options.name === REQUEST)
        record({
          at: wall(),
          provider: text(attributes.provider, 'unknown'),
          model: text(attributes.model, 'unknown'),
          stop: text(attributes.stop, 'unknown'),
          durationMs: clock() - started,
          firstChunkMs: firstChunk,
        });
    }
  };
  return {
    telemetry: { startSpan: start },
    list: () => [...kept],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

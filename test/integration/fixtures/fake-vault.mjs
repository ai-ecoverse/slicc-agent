import { compile } from './scrub.mjs';

export function serveVault(port, values, version = 1) {
  const scrubber = compile(values, version);
  const streams = new Map();
  const log = [];
  const queue = [];
  let paused = false;
  const answer = (message) => {
    const { id, op } = message;
    const reply = (ok) => port.postMessage({ id, ok });
    if (op === 'redact') {
      const texts = message.texts.map((text) =>
        typeof text === 'string' ? scrubber.text(text).text : scrubber.bytes(text)
      );
      return reply({ texts, hits: [], version: scrubber.version });
    }
    if (op === 'redactStream') {
      streams.set(message.stream, scrubber.stream());
      return reply(null);
    }
    const stream = streams.get(message.stream);
    if (!stream) return port.postMessage({ id, error: { message: `no stream ${message.stream}` } });
    if (op === 'push') return reply(stream.push(message.chunk));
    streams.delete(message.stream);
    return reply(op === 'end' ? stream.end() : null);
  };
  port.onmessage = ({ data }) => {
    log.push(data);
    if (paused) queue.push(data);
    else answer(data);
  };
  port.start?.();
  return {
    log,
    pair: { needed: values.length > 0, version },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const message of queue.splice(0)) answer(message);
    },
    publish(pair) {
      port.postMessage({ scrub: pair });
    },
  };
}

export function fakeVault(values, version = 1) {
  const channel = new MessageChannel();
  return { port: channel.port1, ...serveVault(channel.port2, values, version) };
}

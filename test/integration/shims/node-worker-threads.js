const NAME = 'slicc-worker-threads';
const inside =
  typeof WorkerGlobalScope !== 'undefined' &&
  globalThis instanceof WorkerGlobalScope &&
  globalThis.name === NAME;

function events() {
  const listeners = new Map();
  return {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

export class Worker {
  #worker;
  #events = events();

  constructor(url, options = {}) {
    this.#worker = new globalThis.Worker(url, { type: 'module', name: NAME });
    this.#worker.addEventListener('message', (event) => this.#events.emit('message', event.data));
    this.#worker.addEventListener('error', (event) => {
      event.preventDefault();
      this.#events.emit('error', event.error ?? new Error(event.message || 'the worker failed'));
    });
    this.#worker.addEventListener('messageerror', () =>
      this.#events.emit('error', new Error('a message from the worker could not be read'))
    );
    this.#worker.postMessage({ workerData: options.workerData ?? null });
  }

  on(event, listener) {
    this.#events.on(event, listener);
    return this;
  }

  postMessage(message) {
    this.#worker.postMessage(message);
  }

  terminate() {
    this.#worker.terminate();
    return Promise.resolve(1);
  }

  ref() {}

  unref() {}
}

let port = null;
let data = null;
if (inside) {
  const queued = [];
  const listeners = [];
  data = await new Promise((resolve) => {
    globalThis.addEventListener(
      'message',
      (event) => {
        resolve(event.data?.workerData ?? null);
        globalThis.addEventListener('message', (next) => {
          if (listeners.length) for (const listener of listeners) listener(next.data);
          else queued.push(next.data);
        });
      },
      { once: true }
    );
  });
  port = {
    postMessage: (message) => globalThis.postMessage(message),
    on(event, listener) {
      if (event === 'message') {
        listeners.push(listener);
        for (const message of queued.splice(0)) listener(message);
      }
      return port;
    },
  };
}

export const parentPort = port;
export const workerData = data;
export const isMainThread = !inside;
export const threadId = 0;
export default { Worker, parentPort, workerData, isMainThread, threadId };

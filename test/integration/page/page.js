import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { startAgent } from '../../../src/index.ts';
import { bridgePort, connectAgent, connectGuest, linkEndpoint } from '../../../src/page.ts';
import { remoteControl } from '../../../src/remote/client.ts';
import { createAgentModel } from '../../../src/spectrum/index.ts';
import { fakeSealed } from '../fixtures/fake-vault.mjs';

globalThis.startAgent = startAgent;
globalThis.createAgentModel = createAgentModel;
globalThis.BACKGROUND_CONTEXT = BACKGROUND_CONTEXT;
globalThis.remoteControl = remoteControl;
globalThis.connectAgent = connectAgent;
globalThis.connectGuest = connectGuest;
globalThis.bridgePort = bridgePort;
globalThis.linkEndpoint = linkEndpoint;
globalThis.fakeSealed = fakeSealed;
let stages = 0;
globalThis.stage = (what) => {
  stages += 1;
  globalThis.waiting = `${stages}: ${what}`;
};
globalThis.when = (sources, check, what) =>
  new Promise((resolve, reject) => {
    globalThis.stage(what);
    const offs = [];
    let done = false;
    let busy = false;
    let again = false;
    const finish = (settle) => {
      done = true;
      for (const off of offs.splice(0)) off?.();
      settle();
    };
    const look = async () => {
      if (done) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          const value = await check();
          if (value) return finish(() => resolve(value));
        } while (again && !done);
      } catch (error) {
        finish(() => reject(error));
      } finally {
        busy = false;
      }
    };
    const listen = (source) =>
      typeof source === 'function' ? source(look) : source.subscribe(look);
    Promise.all(sources.map(listen)).then((list) => {
      offs.push(...list);
      if (done) for (const off of offs.splice(0)) off?.();
      else void look();
    }, reject);
  });
globalThis.heard =
  (emitter, ...names) =>
  (look) => {
    const offs = names.map((name) => emitter.on(name, look));
    return () => {
      for (const off of offs) off();
    };
  };
const KERNEL = '/node_modules/@ai-ecoverse/slicc-kernel/dist/index.js';
const clients = new WeakMap();
globalThis.files = (kernel, paths) => async (look) => {
  if (!clients.has(kernel))
    clients.set(
      kernel,
      import(KERNEL).then(async ({ attachKernel }) => attachKernel(await kernel.connect()))
    );
  const client = await clients.get(kernel);
  const watcher = await client.fs.watch(paths, { recursive: true }, look);
  return () => watcher.close();
};
globalThis.agentSources = (connection, model) =>
  [
    connection.views,
    connection.agents,
    connection.transcript,
    connection.settings?.state,
    connection.approvals,
    connection.guests,
    connection.frozen,
    connection.importing,
    model && heard(model.agent, 'messages', 'agents', 'active', 'hold', 'frozen', 'importing'),
    model && heard(model.settings, 'accounts', 'providers', 'settings'),
    model?.approvals && heard(model.approvals, 'approvals'),
  ].filter(Boolean);
globalThis.every = (ms) => (look) => {
  const id = setInterval(look, ms);
  return () => clearInterval(id);
};

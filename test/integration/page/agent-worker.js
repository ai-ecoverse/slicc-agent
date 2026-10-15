import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import {
  hostAgent,
  kernelEnvironment,
  kernelPort,
  openAgent,
  openOpfsSqliteStorage,
  serveConnections,
} from '../../../src/index.ts';

const params = new URL(self.location.href).searchParams;
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const script = params
  .getAll('bash')
  .map((command) =>
    fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' })
  );
const seen = [];
const recorded = (message) => (context) => {
  seen.push(JSON.stringify(context.messages.at(-1)?.content ?? ''));
  return message;
};
faux.setResponses(
  [
    ...script,
    ...params.getAll('answer').map((answer) => fauxAssistantMessage([fauxText(answer)])),
  ].map(recorded)
);
const kernel = params.has('kernel');
const port = kernelPort(self);

async function start() {
  const directory = params.get('directory');
  const storage = directory ? await openOpfsSqliteStorage({ directory }) : undefined;
  const registry = createRegistry();
  let env;
  if (kernel) {
    registry.install(CodingTools);
    env = kernelEnvironment(await attachKernel(await port));
  }
  const agent = await openAgent({
    models,
    model: { provider: 'faux', modelId: 'faux-1' },
    storage,
    registry,
    env,
  });
  return hostAgent(agent);
}

const hosted = start();
serveConnections(self, hosted);
self.addEventListener('message', ({ data }) => {
  if (data?.seen) data.seen.postMessage(seen);
  if (data?.seat)
    void hosted.then((host) => data.reply.postMessage(host.guests.record(data.seat) ?? null));
});

import * as bedrock from '@earendil-works/pi-ai/api/bedrock-converse-stream';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { createModels } from '@earendil-works/pi-ai/models';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
import { EventStreamCodec } from '@smithy/core/event-streams';
import { transportFetch } from '../../../src/index.ts';

const encoder = new TextEncoder();
const codec = new EventStreamCodec(
  (bytes) => new TextDecoder().decode(bytes),
  (text) => encoder.encode(text)
);
const frame = (type, body) =>
  codec.encode({
    headers: {
      ':event-type': { type: 'string', value: type },
      ':message-type': { type: 'string', value: 'event' },
      ':content-type': { type: 'string', value: 'application/json' },
    },
    body: encoder.encode(JSON.stringify(body)),
  });

const happy = [
  frame('messageStart', { role: 'assistant' }),
  frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from ' } }),
  frame('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Bedrock.' } }),
  frame('contentBlockStop', { contentBlockIndex: 0 }),
  frame('messageStop', { stopReason: 'end_turn' }),
  frame('metadata', {
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    metrics: { latencyMs: 1 },
  }),
];

const seen = [];
const transport = {
  traits: { crossOrigin: 'any' },
  async fetch(request) {
    const authorization = request.headers.find(
      ([name]) => name.toLowerCase() === 'authorization'
    )?.[1];
    seen.push({ url: request.url, method: request.method, authorization });
    if (authorization !== 'Bearer good-token') {
      async function* denied() {
        yield encoder.encode(
          JSON.stringify({ message: 'The security token included in the request is invalid.' })
        );
      }
      return {
        status: 403,
        statusText: 'Forbidden',
        headers: [
          ['content-type', 'application/json'],
          ['x-amzn-errortype', 'UnrecognizedClientException'],
        ],
        body: denied(),
      };
    }
    async function* stream() {
      for (const chunk of happy) yield chunk;
    }
    return {
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/vnd.amazon.eventstream']],
      body: stream(),
    };
  },
};
setBedrockProviderModule(bedrock);
self.fetch = transportFetch(transport, self.location.origin, self.fetch.bind(self));

const models = createModels();
models.setProvider(amazonBedrockProvider());
const model = models.getModel('amazon-bedrock', 'us.anthropic.claude-sonnet-5-5');
const context = { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] };
const denied = await models.complete(model, context, { apiKey: 'bad-token' });
const answered = await models.complete(model, context, { apiKey: 'good-token' });
self.postMessage({
  seen,
  denied: { stopReason: denied.stopReason, error: denied.errorMessage },
  answered: {
    stopReason: answered.stopReason,
    text: answered.content.map((block) => block.text ?? '').join(''),
    usage: answered.usage.input,
  },
});

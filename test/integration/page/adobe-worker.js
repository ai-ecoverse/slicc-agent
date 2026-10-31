import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { createModels } from '@earendil-works/pi-ai/models';
import { ADOBE, adobeProvider, transportFetch } from '../../../src/index.ts';
import { errorPart } from '../../../src/spectrum/index.ts';
import { adobeProxyAnswer } from '../fixtures/adobe-proxy.mjs';

const encoder = new TextEncoder();
const seen = [];
const transport = {
  traits: { crossOrigin: 'any', redirectPolicy: true },
  async fetch(request) {
    const headers = new Headers(request.headers);
    seen.push({
      url: request.url,
      session: headers.get('x-session-id'),
      version: headers.get('x-slicc-version'),
    });
    const answer = adobeProxyAnswer(request.url, request.method, headers);
    async function* body() {
      yield encoder.encode(answer.body);
    }
    return {
      status: answer.status,
      statusText: '',
      headers: [['content-type', answer.type]],
      body: body(),
    };
  },
};
self.fetch = transportFetch(transport, self.location.origin, self.fetch.bind(self));

const credentials = new InMemoryCredentialStore();
await credentials.modify(ADOBE, async () => ({ type: 'api_key', key: 'tok' }));
const models = createModels({ credentials });
models.setProvider(
  adobeProvider({ endpoint: 'https://adobe.test', session: 'worker-session', version: '1.0.0' })
);
await models.refresh({ providers: [ADOBE] });
const context = { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] };
const answer = async (id) => {
  const reply = await models.complete(models.getModel(ADOBE, id), context, {
    headers: { 'X-Caller': 'c' },
  });
  return {
    stopReason: reply.stopReason,
    text: reply.content.map((block) => block.text ?? '').join(''),
  };
};
const answers = [await answer('claude-x'), await answer('gpt-y')];
const raw = { ...models.getModel(ADOBE, 'claude-x'), provider: 'raw' };
const refused = await anthropicMessagesApi().stream(raw, context, { apiKey: 'tok' }).result();
self.postMessage({
  seen,
  answers,
  refused: errorPart(refused.errorMessage, ADOBE),
});

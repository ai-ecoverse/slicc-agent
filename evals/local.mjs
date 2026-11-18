import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';

export const LOCAL = 'local';
export const LOCAL_BASE = 'http://127.0.0.1:11435/v1';
const API = 'typesafe-system-one';
const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function localProvider(ids, baseUrl = LOCAL_BASE) {
  return createProvider({
    id: LOCAL,
    name: 'Local or self-hosted',
    baseUrl,
    auth: {
      apiKey: {
        name: 'none',
        resolve: async () => ({ auth: { apiKey: 'local' }, source: 'none' }),
      },
    },
    models: ids.map((id) => ({
      type: 'classifier',
      id,
      name: id,
      provider: LOCAL,
      api: API,
      baseUrl,
      input: ['text'],
      cost: free,
      contextWindow: 65536,
    })),
    classifiers: { [API]: typesafeSystemOneApi() },
  });
}

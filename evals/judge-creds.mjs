import { ADOBE } from '../src/adobe.ts';

export const CLOUDFLARE = 'cloudflare-workers-ai';

export function missingJudgeCreds(providers, env = process.env) {
  if (providers.has(ADOBE) && !env.SLICC_ADOBE_IMS_TOKEN) return 'adobe';
  if (providers.has(CLOUDFLARE) && (!env.CLOUDFLARE_API_KEY || !env.CLOUDFLARE_ACCOUNT_ID))
    return 'cloudflare';
  return undefined;
}

export function ensureJudgeCreds(
  providers,
  env = process.env,
  { error = console.error, quit = process.exit } = {}
) {
  const missing = missingJudgeCreds(providers, env);
  if (missing === 'adobe') {
    error('evals/judge.mjs: set SLICC_ADOBE_IMS_TOKEN to run the live judge evals');
    quit(2);
  }
  if (missing === 'cloudflare') {
    error(
      'evals/judge.mjs: set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID to run Cloudflare judge evals'
    );
    quit(2);
  }
}

export function judgeCredentials(env = process.env) {
  const token = env.SLICC_ADOBE_IMS_TOKEN;
  const cfKey = env.CLOUDFLARE_API_KEY;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  return {
    read: async (id) => {
      if (id === ADOBE && token) return { type: 'api_key', key: token };
      if (id === CLOUDFLARE && cfKey)
        return { type: 'api_key', key: cfKey, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
      return undefined;
    },
    list: async () => [
      ...(token ? [{ providerId: ADOBE, type: 'api_key' }] : []),
      ...(cfKey ? [{ providerId: CLOUDFLARE, type: 'api_key' }] : []),
    ],
    modify: async () => undefined,
    delete: async () => undefined,
  };
}

import type { OAuthCredential, Provider, ProviderEnv } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { headerList } from './net.ts';

export const COPILOT = 'github-copilot';
export const COPILOT_ENDPOINT = 'COPILOT_ENDPOINT';

const PLANS: ReadonlySet<string> = new Set(['individual', 'business', 'enterprise']);
const PROXY = /(?:^|;)proxy-ep=proxy\.([a-z]+)\.githubcopilot\.com(?:;|:|$)/;
const GITHUB = /(?:^|\.)(?:github\.com|githubcopilot\.com)$/;

export const COPILOT_BASES: readonly string[] = [...PLANS].map(
  (plan) => `https://api.${plan}.githubcopilot.com`
);

export function copilotBase(env: ProviderEnv | undefined): string {
  const plan = env?.[COPILOT_ENDPOINT];
  return `https://api.${plan && PLANS.has(plan) ? plan : 'individual'}.githubcopilot.com`;
}

export function copilotSettings(credential: OAuthCredential): Record<string, string> {
  const plan = PROXY.exec(credential.access)?.[1];
  return plan && PLANS.has(plan) ? { [COPILOT_ENDPOINT]: plan } : {};
}

export function copilotProvider(): Provider {
  const base = githubCopilotProvider() as Provider;
  return {
    ...base,
    auth: {
      ...base.auth,
      apiKey: {
        name: 'GitHub Copilot sign-in',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (!credential?.key) return undefined;
          return {
            auth: { apiKey: credential.key, baseUrl: copilotBase(credential.env) },
            ...(credential.env ? { env: credential.env } : {}),
            source: 'vault',
          };
        },
      },
    },
  };
}

const API = /^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/;
const SIGN_IN_PATHS = /^\/models(?:\/[^/]+\/policy)?$/;

export function copilotFetch(inner: typeof fetch, direct: typeof fetch): typeof fetch {
  return (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!GITHUB.test(url.hostname)) return inner(request, init);
    const headers = headerList(request, input, init).filter(
      ([name]) => name.toLowerCase() !== 'user-agent'
    );
    const signingIn = API.test(url.hostname) && SIGN_IN_PATHS.test(url.pathname);
    return (signingIn ? direct : inner)(request, { headers });
  };
}

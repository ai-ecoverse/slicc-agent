import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const PROTECTED_RULES = catalog.protectedOrigins;

export interface ProtectedMatcher {
  rule(text: string, options?: { readOnly?: boolean }): string | undefined;
  url(text: string, options?: { readOnly?: boolean }): boolean;
  target(target: { url: string; previous?: boolean; opener?: string }): boolean;
  cookieDomain(domain: string): boolean;
  storageKey(key: string): boolean;
}

export function protectedMatcher(extra: readonly string[] = []): ProtectedMatcher {
  const matcher = protectedOrigins(PROTECTED_RULES, [...extra]);
  const catalogMatcher = protectedOrigins(PROTECTED_RULES);
  return {
    ...matcher,
    rule(text, options) {
      if (!matcher.url(text, options)) return undefined;
      if (!catalogMatcher.url(text, options)) return 'worker origin';
      let url: URL;
      try {
        url = new URL(text);
        for (
          let depth = 0;
          PROTECTED_RULES.innerSchemes.includes(url.protocol.slice(0, -1)) && depth < 8;
          depth++
        )
          url = new URL(url.href.slice(url.protocol.length));
      } catch {
        return 'unparseable protected URL';
      }
      const host = url.hostname.replace(/\.+$/, '');
      if (PROTECTED_RULES.hosts.includes(host)) return `protected host ${host}`;
      const domain = PROTECTED_RULES.domains.find(
        (domain) => host === domain || host.endsWith(`.${domain}`)
      );
      return domain ? `protected domain ${domain}` : `protected scheme ${url.protocol}`;
    },
  };
}

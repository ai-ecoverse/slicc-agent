import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';
import { KERNEL } from '../kernel/loopback.ts';

export const PROTECTED_RULES = catalog.protectedOrigins;

export interface ProtectedMatcher {
  mentions(text: string): boolean;
  rule(text: string, options?: { readOnly?: boolean }): string | undefined;
  url(text: string, options?: { readOnly?: boolean }): boolean;
  target(target: { url: string; previous?: boolean; opener?: string }): boolean;
  cookieDomain(domain: string): boolean;
  storageKey(key: string): boolean;
}

export function folded(text: string): string {
  let value = text;
  for (let depth = 0; depth < 8; depth++) {
    const decoded = value.replace(/(?:%[a-f0-9]{2})+/gi, (encoded) =>
      new TextDecoder().decode(
        Uint8Array.from(encoded.match(/%[a-f0-9]{2}/gi) as string[], (byte) =>
          Number.parseInt(byte.slice(1), 16)
        )
      )
    );
    if (decoded === value) break;
    value = decoded;
  }
  return value
    .normalize('NFKC')
    .replace(/[\u3002\uff0e\uff61]/g, '.')
    .toLowerCase();
}

function hostname(text: string): string {
  try {
    return new URL(text).hostname.replace(/\.+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function protectedMatcher(extra: readonly string[] = []): ProtectedMatcher {
  const matcher = protectedOrigins(PROTECTED_RULES, [...extra]);
  const catalogMatcher = protectedOrigins(PROTECTED_RULES);
  const hosts = [
    ...PROTECTED_RULES.domains,
    ...PROTECTED_RULES.hosts,
    KERNEL,
    ...extra.map(hostname),
  ].filter(Boolean);
  const schemes = [...PROTECTED_RULES.anySchemes, ...PROTECTED_RULES.protectedSchemes].map(
    (scheme) => `${scheme}:`
  );
  return {
    ...matcher,
    mentions(text) {
      const value = folded(text);
      if (/%[a-f0-9]{2}/i.test(value)) return true;
      if (
        schemes.some((scheme) => value.includes(scheme)) ||
        hosts.some((host) => value.includes(host))
      )
        return true;
      return (value.match(/[\p{L}\p{M}\p{N}\p{Cf}_.-]+/gu) ?? []).some((word) => {
        const host = hostname(`https://${word}`);
        return host !== '' && hosts.some((protectedHost) => host.includes(protectedHost));
      });
    },
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

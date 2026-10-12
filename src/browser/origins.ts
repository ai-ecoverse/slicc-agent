import catalog from '@ai-ecoverse/slicc-browsers/catalog.json' with { type: 'json' };
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

export const PROTECTED_RULES = catalog.protectedOrigins;

export interface ProtectedMatcher {
  url(text: string): boolean;
  target(target: { url: string; previous?: boolean; opener?: string }): boolean;
  cookieDomain(domain: string): boolean;
  storageKey(key: string): boolean;
}

export function protectedMatcher(extra: readonly string[] = []): ProtectedMatcher {
  return protectedOrigins(PROTECTED_RULES, [...extra]);
}

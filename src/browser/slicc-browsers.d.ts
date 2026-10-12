declare module '@ai-ecoverse/slicc-browsers/protected.mjs' {
  export function protectedOrigins(
    rules: unknown,
    extraOrigins?: string[]
  ): {
    url(text: string): boolean;
    target(target: { url: string; previous?: boolean; opener?: string }): boolean;
    cookieDomain(domain: string): boolean;
    storageKey(key: string): boolean;
  };
}

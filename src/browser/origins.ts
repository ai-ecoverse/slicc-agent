export const protectedOrigins = {
  patterns: ['https://sliccy.ai', 'https://www.sliccy.ai', 'https://*.sliccy.ai'],
} as const;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.+$/, '');
}

export function originOf(url: string): string | undefined {
  const parsed = parse(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)
    return undefined;
  return `${parsed.protocol}//${hostOf(parsed)}${parsed.port ? `:${parsed.port}` : ''}`;
}

function matches(pattern: string, url: URL): boolean {
  const host = hostOf(url);
  const wanted = pattern.slice('https://'.length);
  if (!wanted.startsWith('*.')) return host === wanted;
  const suffix = wanted.slice(1);
  return host.endsWith(suffix) && LABEL.test(host.slice(0, -suffix.length));
}

export function isProtected(url: string, extra: readonly string[] = []): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  if (extra.some((other) => originOf(other) === origin)) return true;
  const parsed = parse(url) as URL;
  if (parsed.protocol !== 'https:' || parsed.port) return false;
  return protectedOrigins.patterns.some((pattern) => matches(pattern, parsed));
}

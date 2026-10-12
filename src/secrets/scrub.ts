export type Scrubbable = string | Uint8Array;

export interface ScrubStream {
  push(chunk: Uint8Array): Promise<Uint8Array>;
  end(): Promise<Uint8Array>;
  drop(): void;
}

export interface Scrub {
  texts<T extends Scrubbable>(texts: readonly T[]): Promise<T[]>;
  stream(): ScrubStream;
}

const EMPTY = new Uint8Array();

export const IDENTITY: Scrub = {
  texts: async (texts) => [...texts],
  stream: () => ({ push: async (chunk) => chunk, end: async () => EMPTY, drop: () => undefined }),
};

let current: Scrub = IDENTITY;

export function scrubWith(next: Scrub): void {
  current = next;
}

export function scrubTexts<T extends Scrubbable>(texts: readonly T[]): Promise<T[]> {
  return texts.length ? current.texts(texts) : Promise.resolve([]);
}

export async function scrubText(text: string): Promise<string> {
  return (await scrubTexts([text]))[0] as string;
}

export async function scrubItems<T extends { type: string; text?: string }>(
  items: readonly T[]
): Promise<T[]> {
  const scrubbed = await scrubTexts(items.map((item) => item.text ?? ''));
  return items.map((item, at) => (item.type === 'text' ? { ...item, text: scrubbed[at] } : item));
}

export async function scrubbedOutput(
  api: { output(text: string): unknown },
  text: string
): Promise<boolean> {
  try {
    api.output(await scrubText(text));
    return true;
  } catch {
    return false;
  }
}

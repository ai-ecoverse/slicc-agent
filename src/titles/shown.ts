export function labelKey(callIds: readonly string[]): string {
  return callIds.join(' ');
}

export const STEP_KEY = 'step:';

export function stepKey(callId: string): string {
  return `${STEP_KEY}${callId}`;
}

export function callIdsOfKey(key: string): string[] {
  return (key.startsWith(STEP_KEY) ? key.slice(STEP_KEY.length) : key).split(' ');
}

export function shownLabel(
  labels: Readonly<Record<string, string>> | undefined,
  callIds: readonly string[]
): string | null | undefined {
  const key = labelKey(callIds);
  return labels && Object.hasOwn(labels, key) ? labels[key] || null : undefined;
}

const LABEL_WORDS = 8;
const LABEL_LENGTH = 80;

export function cleanLabel(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\.+$/, '')
    .trim()
    .split(' ')
    .slice(0, LABEL_WORDS)
    .join(' ')
    .slice(0, LABEL_LENGTH);
}

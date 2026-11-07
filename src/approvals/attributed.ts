export const UNATTRIBUTED = 'unavailable';

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const stampOf = (request: unknown): Record<string, unknown> =>
  objectOf(objectOf(request).stamp);

export function attributed(request: unknown): boolean {
  const { users } = stampOf(request);
  return users === 'report' || users === 'enforce';
}

export function labelKey(callIds: readonly string[]): string {
  return callIds.join(' ');
}

export function shownLabel(
  labels: Readonly<Record<string, string>> | undefined,
  callIds: readonly string[]
): string | null | undefined {
  const key = labelKey(callIds);
  return labels && Object.hasOwn(labels, key) ? labels[key] || null : undefined;
}

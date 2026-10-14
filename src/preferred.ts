export const BEDROCK = 'amazon-bedrock';

export const PREFERRED_MODELS: Readonly<Record<string, string>> = {
  [BEDROCK]: 'us.anthropic.claude-sonnet-5-5',
};

export function preferredModel<T extends { id: string }>(
  providerId: string,
  available: readonly T[]
): T | undefined {
  const preferredId = PREFERRED_MODELS[providerId];
  return available.find((model) => model.id === preferredId) ?? available[0];
}

import type { SecretName } from './names.ts';
import type { VaultState } from './vault.ts';

export const SECRETS_KIND = 'slicc.secrets';

export interface VaultHold {
  reason: 'waiting' | 'locked';
  held: number;
}

export function vaultHold(state: VaultState | undefined): VaultHold | null {
  if (!state?.needed) return null;
  if (state.locked === 'passkey') return { reason: 'locked', held: state.held };
  return state.port === 'ready' ? null : { reason: 'waiting', held: state.held };
}

export function listedLine(names: readonly SecretName[]): string {
  return `The user listed secrets: ${names.length ? names.map((name) => name.name).join(', ') : 'none'}.`;
}

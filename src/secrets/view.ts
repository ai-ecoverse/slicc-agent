import type { SecretListing } from './names.ts';
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

export function unavailableLine(reason: string): string {
  return `Secrets are unavailable: ${reason.replace(/\.+$/, '')}.`;
}

export function exposedLine(exposed: readonly string[]): string {
  return `Shell grants are off: fnox exec would also give every command the unsealed fnox secrets ${exposed.join(', ')}; seal them or set env = false for them.`;
}

export function listedLine(
  listing: Pick<SecretListing, 'names'> & { error?: string | null; exposed?: string[] }
): string {
  if (listing.error) return unavailableLine(listing.error);
  const listed = `The user listed secrets: ${listing.names.length ? listing.names.map((name) => name.name).join(', ') : 'none'}.`;
  return listing.exposed?.length ? `${listed} ${exposedLine(listing.exposed)}` : listed;
}

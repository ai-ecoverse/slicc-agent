import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { CODEX_ACCOUNT } from '../sign-ins.ts';
import type { VaultRecords } from './records.ts';

const RECORD_ENV: readonly string[] = [CODEX_ACCOUNT];

export const KEYS_IN_VAULT =
  "model keys are kept in seven's vault: enter them in Settings › Accounts";

export type FieldsOf = (providerId: string) => Readonly<Record<string, string>> | undefined;

export function vaultCredentials(
  records: Pick<VaultRecords, 'model' | 'state'>,
  env: FieldsOf = () => undefined,
  ready: (providerId: string) => boolean = () => true
): CredentialStore {
  return {
    async read(providerId) {
      const record = records.model(providerId);
      if (!record || !ready(providerId)) return undefined;
      const carried = Object.fromEntries(
        RECORD_ENV.flatMap((name) => {
          const value = record.settings?.[name];
          return value ? [[name, value]] : [];
        })
      );
      const extra = { ...carried, ...env(providerId) };
      return {
        type: 'api_key',
        key: record.placeholder,
        ...(Object.keys(extra).length ? { env: extra } : {}),
      } satisfies Credential;
    },
    async list() {
      const providers = records.state.value
        .filter((record) => record.kind === 'model' && record.provider !== undefined)
        .map((record) => record.provider as string)
        .filter(ready);
      return [...new Set(providers)].map(
        (providerId): CredentialInfo => ({ providerId, type: 'api_key' })
      );
    },
    async modify() {
      throw new Error(KEYS_IN_VAULT);
    },
    async delete() {
      throw new Error(KEYS_IN_VAULT);
    },
  };
}

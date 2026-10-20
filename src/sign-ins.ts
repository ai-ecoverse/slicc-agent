export const CODEX = 'openai-codex';
export const CODEX_ACCOUNT = 'CHATGPT_ACCOUNT_ID';

export const DEVICE_SIGN_INS: ReadonlySet<string> = new Set(['xai', 'kimi-coding', CODEX]);

export const SIGN_IN_REFUSED = 'The sign-in was refused.';
export const SIGN_IN_UNFINISHED = "The sign-in didn't finish. Try again.";
export const NAME_TAKEN = "This name holds another provider's key.";
export const SIGN_IN_LOCKED = 'Unlock the vault to sign in.';
export const SIGN_IN_UNKEPT = "The vault didn't keep the sign-in. Try again.";
export const DEVICE_NEEDS_VAULT = "Signing in needs seven's vault: update seven";

export interface DeviceSignIn {
  url: string;
  code?: string;
}

export interface ConnectOptions {
  method?: 'sign-in' | 'key';
}

export function httpsUrl(value: unknown): value is string {
  return typeof value === 'string' && URL.parse(value)?.protocol === 'https:';
}

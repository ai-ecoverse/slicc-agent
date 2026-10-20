import type {
  Account,
  ModelOption,
  Settings,
  SettingsEvents,
  SettingsPort,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { preferredModel } from '../preferred.ts';
import type { AgentSettings, ProviderOption, SettingsState, SignIn } from '../services.ts';
import {
  type ConnectOptions,
  DEVICE_SIGN_INS,
  type DeviceSignIn,
  httpsUrl,
  SIGN_IN_UNFINISHED,
} from '../sign-ins.ts';
import type { AgentAdapter } from './agent-port.ts';
import { attempt } from './attempt.ts';
import { Emitter } from './emitter.ts';
import { askHold, markerUrl, UNHELD } from './held.ts';
import { mcpLogin, type SignInWindow, untilAborted } from './mcp-login.ts';

export const SETTINGS_KEY = 'slicc-agent.settings';

const defaults: Settings = {
  color: 'system',
  model: '',
  thinking: 'off',
  sendOnEnter: true,
  showThinking: false,
  diffStyle: 'unified',
};

type Local = Omit<Settings, 'model' | 'thinking'>;

export type Sealed = { sealed: true };

export type Login = (
  providerId: string,
  signIn: () => Promise<SignIn | null>,
  options: { signal: AbortSignal }
) => Promise<string | Sealed>;

export const SIGN_IN_NEEDS_VAULT = "Adobe sign-in needs seven's vault: update seven";
export const UNFINISHED = SIGN_IN_UNFINISHED;

const signInWindow: SignInWindow = {
  open: (url) => globalThis.open?.(url, 'slicc-sign-in', 'popup,width=520,height=720') ?? null,
  hold: (marker, signal) => askHold(marker, signal),
};

export function readable(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'AbortError') return error;
  const text = (error instanceof Error ? error.message : String(error ?? '')).trim();
  if (!text) return new Error(UNFINISHED);
  const lead = /^[a-z]+\b(?![-.@/])/.test(text) ? text[0].toUpperCase() + text.slice(1) : text;
  return new Error(/[.!?]$/.test(lead) ? lead : `${lead}.`);
}

type Events = SettingsEvents & { providers: readonly ProviderOption[] };

export class SettingsAdapter extends Emitter<Events> implements SettingsPort {
  readonly #settings: AgentSettings;
  readonly #agent: AgentAdapter;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly #login: Login | null;
  readonly #mcpLogin: Login;
  readonly #signing = new Map<string, AbortController>();
  readonly #prompts = new Map<string, DeviceSignIn>();
  readonly #window: SignInWindow;
  #local: Local;
  #offered = '';
  readonly #urls = new Map<string, string>();

  constructor(
    settings: AgentSettings,
    agent: AgentAdapter,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    login: Login | null = null,
    mcp: Login = mcpLogin() as Login,
    popups: SignInWindow = signInWindow
  ) {
    super();
    this.#mcpLogin = mcp;
    this.#window = popups;
    this.#settings = settings;
    this.#agent = agent;
    this.#storage = storage;
    this.#login = login;
    const saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<Local>;
    const { model: _model, thinking: _thinking, ...local } = { ...defaults, ...saved };
    this.#local = local;
    this.#offered = JSON.stringify(this.providers());
    this.#locate();
    settings.state.subscribe(() => {
      this.#locate();
      this.emit('accounts', this.accounts());
      this.emit('settings', this.get());
      const offered = JSON.stringify(this.providers());
      if (offered === this.#offered) return;
      this.#offered = offered;
      this.emit('providers', this.providers());
    });
    agent.on('agents', () => this.emit('settings', this.get()));
  }

  #locate(): void {
    const servers = this.#state()
      .accounts.filter(({ group }) => group === 'mcp')
      .map(({ id }) => id);
    for (const id of this.#urls.keys()) if (!servers.includes(id)) this.#urls.delete(id);
    for (const id of servers) {
      void this.#settings
        .serverUrl?.(id, BACKGROUND_CONTEXT)
        .then((url) => {
          if ((url ?? undefined) === this.#urls.get(id)) return;
          if (url) this.#urls.set(id, url);
          else this.#urls.delete(id);
          this.emit('accounts', this.accounts());
        })
        .catch(() => undefined);
    }
  }

  #state(): SettingsState {
    return this.#settings.state.value ?? { models: [], accounts: [] };
  }

  get(): Settings {
    const cone = this.#agent.list()[0];
    return { ...this.#local, model: cone?.model ?? '', thinking: cone?.thinking ?? 'off' };
  }

  update(patch: Partial<Settings>): void {
    const { model, thinking, ...local } = patch;
    const id = this.#agent.active();
    if (model !== undefined) this.#agent.setModel(id, model);
    if (thinking !== undefined) this.#agent.setThinking(id, thinking);
    this.#local = { ...this.#local, ...local };
    this.#storage?.setItem(SETTINGS_KEY, JSON.stringify(this.#local));
    this.emit('settings', this.get());
  }

  models(): readonly ModelOption[] {
    const choices = this.#state().models;
    const groups = Map.groupBy(choices, ({ id }) => id.slice(0, id.indexOf('/')));
    const chosen = new Set(
      [...groups].map(
        ([providerId, group]) =>
          preferredModel(
            providerId,
            group.map((choice) => ({ id: choice.id.slice(providerId.length + 1), choice }))
          )?.choice
      )
    );
    return choices.map((choice) => {
      const { id, label, provider, kind, reasoning, images } = choice;
      return {
        id,
        label,
        provider,
        kind,
        reasoning,
        ...(images === undefined ? {} : { images }),
        ...(chosen.has(choice) ? { default: true } : {}),
      };
    });
  }

  #offer(id: string) {
    const option = this.providers().find((candidate) => candidate.id === id);
    if (!option) return undefined;
    return {
      auth: option.auth === 'oauth' ? ('oauth' as const) : ('api-key' as const),
      store: 'vault' as const,
      group: 'providers' as const,
    };
  }

  providers(): readonly ProviderOption[] {
    return this.#state().providers ?? [];
  }

  async remove(id: string): Promise<void> {
    this.cancel(id);
    await this.#settings.remove(id, BACKGROUND_CONTEXT);
  }

  accounts(): readonly Account[] {
    return this.#state().accounts.map(({ needs, ...account }) => {
      const url = this.#urls.get(account.id);
      const located = url ? { ...account, url } : account;
      const prompt = this.#prompts.get(account.id);
      const shown = this.#signing.has(account.id)
        ? {
            ...located,
            status: 'signing-in' as const,
            ...(prompt ? { signIn: { ...prompt } } : {}),
          }
        : located;
      return needs ? { ...shown, needs } : shown;
    });
  }

  async connect(
    id: string,
    secret?: string,
    fields?: Record<string, string>,
    options?: ConnectOptions
  ): Promise<void> {
    const account =
      this.#state().accounts.find((candidate) => candidate.id === id) ?? this.#offer(id);
    const mcp = account?.group === 'mcp';
    const given = fields ? { ...fields } : null;
    const keyed = options?.method === 'key';
    if (account?.auth === 'oauth' && DEVICE_SIGN_INS.has(id) && secret === undefined && !keyed)
      return this.#device(id, given);
    const login = account?.auth !== 'oauth' || keyed ? null : mcp ? this.#mcpLogin : this.#login;
    if (keyed) this.cancel(id);
    if (secret !== undefined) {
      await this.#settings.connect(id, secret, given, BACKGROUND_CONTEXT);
      return;
    }
    if (account?.auth === 'oauth' && !login && !keyed) throw new Error(`${id} needs a sign-in`);
    if (!login) {
      if (account?.store !== 'vault') throw new Error(`${id} needs an API key`);
      await this.#settings.connect(id, null, given, BACKGROUND_CONTEXT);
      return;
    }
    const answer = await this.#signIn(id, login);
    if (typeof answer === 'string') {
      if (!mcp) throw new Error(SIGN_IN_NEEDS_VAULT);
      await this.#settings.connect(id, answer, given, BACKGROUND_CONTEXT);
      return;
    }
    if (answer?.sealed !== true) throw new Error(UNFINISHED);
    await this.#settings.connect(id, null, given, BACKGROUND_CONTEXT);
  }

  #begin(id: string): AbortController {
    const controller = new AbortController();
    this.#signing
      .get(id)
      ?.abort(new DOMException('A newer sign-in replaced this one.', 'AbortError'));
    this.#signing.set(id, controller);
    this.#prompts.delete(id);
    this.emit('accounts', this.accounts());
    return controller;
  }

  #end(id: string, controller: AbortController): void {
    if (this.#signing.get(id) === controller) {
      this.#signing.delete(id);
      this.#prompts.delete(id);
    }
    this.emit('accounts', this.accounts());
  }

  async #device(id: string, given: Record<string, string> | null): Promise<void> {
    const marker = crypto.randomUUID();
    const popup = this.#window.open(markerUrl(marker));
    const controller = this.#begin(id);
    const { signal } = controller;
    const held = popup ? this.#window.hold(marker, signal) : Promise.resolve(false);
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    try {
      const started = (await untilAborted(
        this.#settings.signIn(id, context),
        signal
      )) as DeviceSignIn | null;
      if (!started || !httpsUrl(started.url)) throw new Error(UNFINISHED);
      if (popup && !(await untilAborted(held, signal))) throw new Error(UNHELD);
      const code = typeof started.code === 'string' && started.code ? started.code : undefined;
      this.#prompts.set(id, { url: started.url, ...(code ? { code } : {}) });
      this.emit('accounts', this.accounts());
      if (popup) popup.location.href = started.url;
      await untilAborted(this.#settings.connect(id, null, given, context), signal);
    } catch (error) {
      signal.throwIfAborted();
      throw readable(error);
    } finally {
      popup?.close();
      this.#end(id, controller);
    }
  }

  async #signIn(id: string, login: Login): Promise<string | Sealed> {
    const controller = this.#begin(id);
    try {
      const key = await login(
        id,
        () => this.#settings.signIn(id, BACKGROUND_CONTEXT) as Promise<SignIn | null>,
        {
          signal: controller.signal,
        }
      ).catch((error: unknown) => {
        controller.signal.throwIfAborted();
        throw readable(error);
      });
      controller.signal.throwIfAborted();
      return key;
    } finally {
      this.#end(id, controller);
    }
  }

  cancel(id: string): void {
    const controller = this.#signing.get(id);
    if (!controller) return;
    this.#signing.delete(id);
    this.#prompts.delete(id);
    controller.abort(new DOMException('The sign-in was cancelled.', 'AbortError'));
    this.emit('accounts', this.accounts());
  }

  disconnect(id: string): void {
    attempt(this.#settings.disconnect(id, BACKGROUND_CONTEXT), 'disconnect accounts', (text) =>
      this.#agent.notify(text)
    );
  }
}

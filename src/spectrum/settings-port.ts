import type {
  Account,
  ModelOption,
  Settings,
  SettingsEvents,
  SettingsPort,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AgentSettings, SettingsState, SignIn } from '../services.ts';
import type { AgentAdapter } from './agent-port.ts';
import { attempt } from './attempt.ts';
import { Emitter } from './emitter.ts';
import { mcpLogin } from './mcp-login.ts';

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

export class SettingsAdapter extends Emitter<SettingsEvents> implements SettingsPort {
  readonly #settings: AgentSettings;
  readonly #agent: AgentAdapter;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly #login: Login | null;
  readonly #mcpLogin: Login;
  readonly #signing = new Map<string, AbortController>();
  #local: Local;

  constructor(
    settings: AgentSettings,
    agent: AgentAdapter,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    login: Login | null = null,
    mcp: Login = mcpLogin() as Login
  ) {
    super();
    this.#mcpLogin = mcp;
    this.#settings = settings;
    this.#agent = agent;
    this.#storage = storage;
    this.#login = login;
    const saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}') as Partial<Local>;
    const { model: _model, thinking: _thinking, ...local } = { ...defaults, ...saved };
    this.#local = local;
    settings.state.subscribe(() => {
      this.emit('accounts', this.accounts());
      this.emit('settings', this.get());
    });
    agent.on('agents', () => this.emit('settings', this.get()));
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
    return this.#state().models.map(({ id, label, provider, kind, reasoning, images }) => ({
      id,
      label,
      provider,
      kind,
      reasoning,
      ...(images === undefined ? {} : { images }),
    }));
  }

  accounts(): readonly Account[] {
    return this.#state().accounts.map(({ needs, ...account }) => {
      const shown = this.#signing.has(account.id)
        ? { ...account, status: 'signing-in' as const }
        : account;
      return needs ? { ...shown, needs } : shown;
    });
  }

  async connect(id: string, secret?: string, fields?: Record<string, string>): Promise<void> {
    const account = this.#state().accounts.find((candidate) => candidate.id === id);
    const mcp = account?.group === 'mcp';
    const login = account?.auth !== 'oauth' ? null : mcp ? this.#mcpLogin : this.#login;
    const given = fields ? { ...fields } : null;
    if (secret !== undefined) {
      await this.#settings.connect(id, secret, given, BACKGROUND_CONTEXT);
      return;
    }
    if (account?.auth === 'oauth' && !login) throw new Error(`${id} needs a sign-in`);
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
    if (answer?.sealed !== true) throw new Error(`${id}'s sign-in didn't finish`);
    await this.#settings.connect(id, null, given, BACKGROUND_CONTEXT);
  }

  async #signIn(id: string, login: Login): Promise<string | Sealed> {
    const controller = new AbortController();
    this.#signing
      .get(id)
      ?.abort(new DOMException('A newer sign-in replaced this one.', 'AbortError'));
    this.#signing.set(id, controller);
    this.emit('accounts', this.accounts());
    try {
      const key = await login(
        id,
        () => this.#settings.signIn(id, BACKGROUND_CONTEXT) as Promise<SignIn | null>,
        {
          signal: controller.signal,
        }
      );
      controller.signal.throwIfAborted();
      return key;
    } finally {
      if (this.#signing.get(id) === controller) this.#signing.delete(id);
      this.emit('accounts', this.accounts());
    }
  }

  cancel(id: string): void {
    const controller = this.#signing.get(id);
    if (!controller) return;
    this.#signing.delete(id);
    controller.abort(new DOMException('The sign-in was cancelled.', 'AbortError'));
    this.emit('accounts', this.accounts());
  }

  disconnect(id: string): void {
    attempt(this.#settings.disconnect(id, BACKGROUND_CONTEXT), 'disconnect accounts', (text) =>
      this.#agent.notify(text)
    );
  }
}

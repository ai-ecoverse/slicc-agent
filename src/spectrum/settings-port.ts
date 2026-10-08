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
import { Emitter } from './emitter.ts';

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

export type Login = (providerId: string, signIn: () => Promise<SignIn | null>) => Promise<string>;

export class SettingsAdapter extends Emitter<SettingsEvents> implements SettingsPort {
  readonly #settings: AgentSettings;
  readonly #agent: AgentAdapter;
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly #login: Login | null;
  #local: Local;

  constructor(
    settings: AgentSettings,
    agent: AgentAdapter,
    storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    login: Login | null = null
  ) {
    super();
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
    return this.#state().models.map(({ id, label, provider, kind, reasoning }) => ({
      id,
      label,
      provider,
      kind,
      reasoning,
    }));
  }

  accounts(): readonly Account[] {
    return this.#state().accounts.map(({ needs, ...account }) =>
      needs ? { ...account, needs } : account
    );
  }

  async connect(id: string, secret?: string, options: { region?: string } = {}): Promise<void> {
    const account = this.#state().accounts.find((candidate) => candidate.id === id);
    const login = account?.auth === 'oauth' ? this.#login : null;
    const key =
      secret ??
      (login ? await login(id, () => this.#settings.signIn(id, BACKGROUND_CONTEXT)) : undefined);
    if (!key)
      throw new Error(`${id} needs ${account?.auth === 'oauth' ? 'a sign-in' : 'an API key'}`);
    await this.#settings.connect(id, key, options.region ?? null, BACKGROUND_CONTEXT);
  }

  disconnect(id: string): void {
    void this.#settings.disconnect(id, BACKGROUND_CONTEXT);
  }
}

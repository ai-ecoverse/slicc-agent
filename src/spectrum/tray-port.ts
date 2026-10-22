import type { TrayEvents, TrayPort, TrayStatus } from '@ai-ecoverse/slicc-spectrum/ui';
import type { AgentSettings } from '../services.ts';
import { type Selected, selectedBudget } from './budget.ts';
import { Emitter } from './emitter.ts';

export class TrayAdapter extends Emitter<TrayEvents> implements TrayPort {
  readonly #settings: AgentSettings;
  readonly #selected: Selected | undefined;
  #shown = '';

  constructor(settings: AgentSettings, selected?: Selected) {
    super();
    this.#settings = settings;
    this.#selected = selected;
    settings.state.subscribe(() => this.emit('status', this.status()));
    selected?.onChange(() => {
      const before = this.#shown;
      const status = this.status();
      if (this.#shown !== before) this.emit('status', status);
    });
  }

  status(): TrayStatus {
    const budget = selectedBudget(this.#settings.state.value, this.#selected?.provider());
    const shown = budget
      ? {
          percent: budget.percent,
          window: budget.window,
          resets: budget.resets,
          provider: budget.provider,
        }
      : { percent: 0, window: 'weekly' as const, resets: '' };
    this.#shown = JSON.stringify(shown);
    return {
      name: 'slicc',
      kind: 'hosted',
      connection: 'offline',
      role: 'none',
      followers: [],
      budget: shown,
      joinUrl: '',
    };
  }

  reconnect(): void {}

  disconnect(): void {}
}

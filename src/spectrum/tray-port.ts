import type { TrayEvents, TrayPort, TrayStatus } from '@ai-ecoverse/slicc-spectrum/ui';
import type { AgentSettings } from '../services.ts';
import { Emitter } from './emitter.ts';

export class TrayAdapter extends Emitter<TrayEvents> implements TrayPort {
  readonly #settings: AgentSettings;

  constructor(settings: AgentSettings) {
    super();
    this.#settings = settings;
    settings.state.subscribe(() => this.emit('status', this.status()));
  }

  status(): TrayStatus {
    const budget = this.#settings.state.value?.budget;
    return {
      name: 'slicc',
      kind: 'hosted',
      connection: 'offline',
      role: 'none',
      followers: [],
      spent: 0,
      rate: 0,
      budget: budget
        ? { percent: budget.percent, window: budget.window, resets: budget.resets }
        : { percent: 0, window: 'weekly', resets: '' },
      joinUrl: '',
    };
  }

  reconnect(): void {}

  disconnect(): void {}
}

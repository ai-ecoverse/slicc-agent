import type { Notice, NoticesPort } from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { MovedName } from '../secrets/legacy.ts';
import type { AgentSettings } from '../services.ts';
import { attempt, type Report } from './attempt.ts';
import { Emitter } from './emitter.ts';

export const KEYS_MOVED = 'keys-moved';

function servers(names: readonly string[], lead: boolean): string {
  if (names.length > 1) return `MCP servers: ${names.join(', ')}`;
  return `${lead ? 'the' : 'and the'} MCP server ${names[0]}`;
}

export function movedList(accounts: readonly MovedName[]): string {
  const models = accounts.filter((name) => name.kind === 'model').map((name) => name.label);
  const mcp = accounts.filter((name) => name.kind === 'mcp').map((name) => name.label);
  if (!mcp.length) return models.join(', ');
  if (!models.length) return servers(mcp, true);
  return `${models.join(', ')}${mcp.length > 1 ? '; ' : ', '}${servers(mcp, false)}`;
}

export function movedNotice(accounts: readonly MovedName[]): Notice {
  return {
    id: KEYS_MOVED,
    tone: 'info',
    title: "Your keys moved to seven's vault.",
    body: `Add them again in Settings › Accounts: ${movedList(accounts)}.`,
    actions: [],
  };
}

export type HostNotices = Pick<NoticesPort, 'list' | 'act' | 'dismiss' | 'on'>;

export class NoticesAdapter extends Emitter<{ notices: readonly Notice[] }> implements NoticesPort {
  readonly #settings: AgentSettings;
  readonly #report: Report;
  readonly #host: HostNotices | undefined;
  #hidden = false;

  constructor(settings: AgentSettings, report: Report, host?: HostNotices) {
    super();
    this.#settings = settings;
    this.#report = report;
    this.#host = host;
    settings.state.subscribe(() => this.emit('notices', this.list()));
    host?.on('notices', () => this.emit('notices', this.list()));
  }

  list(): readonly Notice[] {
    return [...(this.#host?.list() ?? []), ...this.#agent()];
  }

  #agent(): readonly Notice[] {
    const moved = this.#settings.state.value?.moved;
    return moved?.length && !this.#hidden ? [movedNotice(moved)] : [];
  }

  #hosts(id: string): Notice | undefined {
    return this.#host?.list().find((notice) => notice.id === id);
  }

  async act(id: string, action: string): Promise<void> {
    if (this.#hosts(id)) await this.#host?.act(id, action);
  }

  dismiss(id: string): void {
    const hosted = this.#hosts(id);
    if (hosted) {
      if (hosted.dismissible !== false) this.#host?.dismiss(id);
      return;
    }
    if (id !== KEYS_MOVED) return;
    this.#hidden = true;
    this.emit('notices', this.list());
    attempt(this.#settings.dismissMoved(BACKGROUND_CONTEXT), 'dismiss the notice', this.#report);
  }
}

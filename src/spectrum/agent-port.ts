import type {
  Agent,
  AgentEvents,
  AgentPort,
  AgentStatus,
  FrozenCone,
  Message,
  Outgoing,
  SlashCommand,
  Thinking,
  UserMessage,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { AgentConnection } from '../client.ts';
import { entryLick } from '../licks/state.ts';
import type { AgentSettingsChange } from '../services.ts';
import { Emitter } from './emitter.ts';
import { isBusy, queued, toMessages } from './messages.ts';

export const CONE = 'cone';

const thinking: Record<string, Thinking> = {
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

interface AgentDoc {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

function status(view: ConversationView | undefined, messages: readonly Message[]): AgentStatus {
  if (isBusy(view)) {
    const live = view?.docs['pi.live'] as { tools?: { status: string }[] } | undefined;
    return live?.tools?.some((slot) => slot.status === 'running') ? 'working' : 'thinking';
  }
  const last = messages.at(-1);
  return last?.role === 'assistant' && last.status === 'error' ? 'error' : 'idle';
}

export class AgentAdapter extends Emitter<AgentEvents> implements AgentPort {
  readonly #connection: AgentConnection;
  readonly #ready: Promise<void>;
  #messages: Message[] = [];

  constructor(connection: AgentConnection) {
    super();
    this.#connection = connection;
    this.#ready = new Promise((resolve) => {
      connection.transcript.subscribe((view) => {
        this.#update(view);
        resolve();
      });
      connection.deliveries.subscribe(() => {
        const view = this.#view();
        if (view) this.#update(view);
      });
    });
  }

  #view(): ConversationView | undefined {
    return this.#connection.transcript.value;
  }

  #update(view: ConversationView): void {
    const before = this.#messages;
    this.#messages = toMessages(view, this.#connection.deliveries.value);
    this.emit('agents', this.list());
    if (before.length !== this.#messages.length) {
      this.emit('messages', CONE);
      return;
    }
    const changed = this.#messages.filter(
      (message, index) => JSON.stringify(message) !== JSON.stringify(before[index])
    );
    if (changed.length === 1)
      this.emit('message', { agentId: CONE, message: changed[0] as Message });
    else if (changed.length > 1) this.emit('messages', CONE);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  list(): readonly Agent[] {
    const doc = this.#view()?.docs['pi.agent'] as AgentDoc | undefined;
    return [
      {
        id: CONE,
        name: 'sliccy',
        kind: 'cone',
        parentId: null,
        status: status(this.#view(), this.#messages),
        model: doc?.model ? `${doc.model.provider}/${doc.model.modelId}` : '',
        contextFill: 0,
        unread: 0,
        thinking: thinking[doc?.thinkingLevel ?? 'off'] ?? 'off',
      },
    ];
  }

  active(): string {
    return CONE;
  }

  select(): void {}

  messages(): readonly Message[] {
    return this.#messages;
  }

  async send(_agentId: string, input: string | Outgoing): Promise<void> {
    const outgoing = typeof input === 'string' ? { text: input } : input;
    const sent = await this.#connection.control.send(
      {
        text: outgoing.text,
        whenBusy: outgoing.mode === 'queue' ? 'followUp' : 'steer',
        requestId: crypto.randomUUID(),
      },
      BACKGROUND_CONTEXT
    );
    if (!sent.accepted) throw new Error(sent.error.message);
  }

  async rewind(_agentId: string, messageId: string): Promise<Outgoing | null> {
    const rewound = await this.#connection.control.rewind(messageId, BACKGROUND_CONTEXT);
    return rewound.done ? { text: rewound.text } : null;
  }

  stop(): void {
    void this.#connection.control.abort(BACKGROUND_CONTEXT);
  }

  busy(): boolean {
    return isBusy(this.#view());
  }

  queue(): readonly UserMessage[] {
    return queued(this.#view());
  }

  unqueue(_agentId: string, messageId: string): void {
    void this.#connection.control.withdraw(messageId.replace(/^q/, ''), BACKGROUND_CONTEXT);
  }

  suggestion(): string | null {
    return null;
  }

  answer(): void {}

  resolveLick(_agentId: string, messageId: string, state: 'confirmed' | 'dismissed'): void {
    const message = this.#messages.find((candidate) => candidate.id === messageId);
    const entry = this.#view()?.entries.find((candidate) => `e${candidate.id}` === messageId);
    const lick = message?.role === 'lick' && entry ? entryLick(entry) : undefined;
    if (lick) void this.#connection.control.resolveLick(lick.id, state, BACKGROUND_CONTEXT);
  }

  compact(): void {
    void this.#connection.control.compact(null, BACKGROUND_CONTEXT);
  }

  clear(): void {
    void this.#connection.control.reset(null, BACKGROUND_CONTEXT);
  }

  #configure(change: Partial<AgentSettingsChange>): void {
    void this.#connection.control.configure(
      { model: change.model ?? null, thinkingLevel: change.thinkingLevel ?? null },
      BACKGROUND_CONTEXT
    );
  }

  setModel(_agentId: string, model: string): void {
    const at = model.indexOf('/');
    if (at <= 0) return;
    this.#configure({ model: { provider: model.slice(0, at), modelId: model.slice(at + 1) } });
  }

  setThinking(_agentId: string, level: Thinking): void {
    this.#configure({ thinkingLevel: level });
  }

  async older(): Promise<readonly Message[]> {
    return [];
  }

  commands(): readonly SlashCommand[] {
    return [];
  }

  createScoop(): Agent {
    throw new Error('Scoops come with a later slicc-agent');
  }

  frozen(): readonly FrozenCone[] {
    return [];
  }

  freeze(): void {}

  thaw(): Agent | null {
    return null;
  }

  discard(): void {}
}

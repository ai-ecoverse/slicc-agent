import type {
  Agent,
  AgentEvents,
  AgentPort,
  AgentStatus,
  FrozenCone,
  Message,
  Outgoing,
  SlashCommand,
  SystemMessage,
  Thinking,
  UserMessage,
} from '@ai-ecoverse/slicc-spectrum/ui';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { AgentConnection } from '../client.ts';
import { shrink } from '../images/fit.ts';
import { entryLick } from '../licks/state.ts';
import { type VaultHold, vaultHold } from '../secrets/view.ts';
import type { AgentSettingsChange, AgentSummary, Command } from '../services.ts';
import { attempt } from './attempt.ts';
import { Emitter } from './emitter.ts';
import { isBusy, queued, toMessages } from './messages.ts';
import { readUrl, sendAttachments } from './outgoing.ts';

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

export function slashCommand({ kind, ...command }: Command): SlashCommand {
  return kind === 'action' ? command : { ...command, kind };
}

export type AgentHold = VaultHold;

export type AgentAdapterEvents = AgentEvents & { hold: AgentHold | null };

function sameHold(a: AgentHold | null, b: AgentHold | null): boolean {
  return a === b || (a !== null && b !== null && a.reason === b.reason && a.held === b.held);
}

interface Pending {
  agentId: string;
  message: UserMessage;
  dropped: boolean;
  release(): void;
  released: Promise<void>;
}

export class AgentAdapter extends Emitter<AgentAdapterEvents> implements AgentPort {
  readonly #connection: AgentConnection;
  readonly #ready: Promise<void>;
  readonly #messages = new Map<string, Message[]>();
  #active: string | null = null;
  #creating = new Map<string, Promise<string | null>>();
  #hold: AgentHold | null = null;
  readonly #outbox = new Map<string, Pending>();
  readonly #notices = new Map<string, { at: number; message: SystemMessage }[]>();

  constructor(connection: AgentConnection) {
    super();
    this.#connection = connection;
    this.#hold = this.hold();
    connection.vault?.subscribe(() => {
      const next = this.hold();
      if (sameHold(next, this.#hold)) return;
      this.#hold = next;
      if (!next) for (const pending of this.#outbox.values()) pending.release();
      this.emit('hold', next);
      this.emit('agents', this.list());
    });
    connection.frozen?.subscribe(() => {
      this.emit('frozen', this.frozen());
      this.emit('agents', this.list());
    });
    this.#ready = new Promise((resolve) => {
      connection.transcript.subscribe(() => {
        this.#refresh();
        resolve();
      });
      connection.deliveries.subscribe(() => this.#refresh());
      connection.views?.subscribe(() => this.#refresh());
      connection.agents?.subscribe(() => this.#refresh());
    });
  }

  #summary(): readonly AgentSummary[] {
    const agents = this.#connection.agents?.value?.agents;
    return agents?.length
      ? agents
      : [{ id: CONE, name: 'sliccy', kind: 'cone', parentId: null, role: null }];
  }

  #view(agentId: string = this.active()): ConversationView | undefined {
    const views = this.#connection.views?.value;
    const view = views?.[agentId];
    if (view) return view;
    const cone = this.#connection.agents?.value?.active ?? CONE;
    return agentId === cone ? this.#connection.transcript.value : undefined;
  }

  #refresh(): void {
    this.#active ??= this.#connection.agents?.value?.active ?? null;
    this.emit('agents', this.list());
    for (const summary of this.#summary()) this.#update(summary.id);
    for (const id of [...this.#messages.keys(), ...this.#notices.keys()])
      if (!this.#summary().some((summary) => summary.id === id)) {
        this.#messages.delete(id);
        this.#notices.delete(id);
      }
  }

  notify(text: string, agentId: string = this.active()): void {
    const notes = this.#notices.get(agentId) ?? [];
    notes.push({
      at: this.#messages.get(agentId)?.length ?? 0,
      message: {
        id: `n${crypto.randomUUID()}`,
        role: 'system',
        kind: 'notice',
        text,
        createdAt: Date.now(),
      },
    });
    this.#notices.set(agentId, notes);
    this.emit('messages', agentId);
  }

  #report(agentId: string): (text: string) => void {
    return (text) => this.notify(text, agentId);
  }

  #update(agentId: string): void {
    const view = this.#view(agentId);
    if (!view) return;
    const before = this.#messages.get(agentId) ?? [];
    const after = toMessages(view, this.#connection.deliveries.value);
    this.#messages.set(agentId, after);
    if (before.length !== after.length) {
      this.emit('messages', agentId);
      return;
    }
    const changed = after.filter(
      (message, index) => JSON.stringify(message) !== JSON.stringify(before[index])
    );
    if (changed.length === 1) this.emit('message', { agentId, message: changed[0] as Message });
    else if (changed.length > 1) this.emit('messages', agentId);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  hold(): AgentHold | null {
    return vaultHold(this.#connection.vault?.value);
  }

  list(): readonly Agent[] {
    const rows = this.#connection.frozen?.value ?? [];
    return this.#summary().map((summary) => {
      const view = this.#view(summary.id);
      const doc = view?.docs['pi.agent'] as AgentDoc | undefined;
      const title =
        summary.kind === 'cone' ? rows.find((row) => row.id === summary.id)?.title : undefined;
      return {
        id: summary.id,
        name: summary.role ? `${summary.name} · ${summary.role}` : summary.name,
        kind: summary.kind,
        parentId: summary.parentId,
        status: this.#status(summary.id, status(view, this.#messages.get(summary.id) ?? [])),
        model: doc?.model ? `${doc.model.provider}/${doc.model.modelId}` : '',
        contextFill: 0,
        unread: 0,
        thinking: thinking[doc?.thinkingLevel ?? 'off'] ?? 'off',
        ...(title ? { title } : {}),
      };
    });
  }

  active(): string {
    const known = this.#summary();
    if (this.#active && this.#creating.has(this.#active)) return this.#active;
    if (this.#active && known.some((summary) => summary.id === this.#active)) return this.#active;
    return this.#connection.agents?.value?.active ?? CONE;
  }

  select(id: string): void {
    if (this.#creating.has(id)) {
      this.#active = id;
      this.emit('active', id);
      return;
    }
    const found = this.#summary().find((summary) => summary.id === id);
    if (!found) return;
    this.#active = id;
    if (found.kind === 'cone')
      attempt(
        this.#connection.control.selectCone(id, BACKGROUND_CONTEXT),
        'switch cones',
        this.#report(id)
      );
    this.emit('active', id);
    this.emit('messages', id);
  }

  messages(agentId: string = this.active()): readonly Message[] {
    const shown = this.#messages.get(agentId) ?? [];
    const notes = this.#notices.get(agentId);
    if (!notes) return shown;
    const at = (index: number) => notes.filter((note) => note.at === index).map((n) => n.message);
    const late = notes.filter((note) => note.at >= shown.length).map((note) => note.message);
    return [...shown.flatMap((message, index) => [...at(index), message]), ...late];
  }

  async send(agentId: string, input: string | Outgoing): Promise<void> {
    const outgoing = typeof input === 'string' ? { text: input } : input;
    const attachments = outgoing.attachments?.length
      ? await sendAttachments(outgoing.attachments, readUrl, shrink, (ref) =>
          this.#connection.control.image(ref, BACKGROUND_CONTEXT)
        ).catch((error: Error) => {
          this.notify(error.message, agentId);
          return null;
        })
      : [];
    if (!attachments) return;
    const target = this.#creating.has(agentId) ? await this.#creating.get(agentId) : agentId;
    if (target === null) throw new Error('The scoop could not be created.');
    const pending = target && this.#held(target) ? this.#pending(target, outgoing) : undefined;
    if (pending) await pending.released;
    if (pending?.dropped) return this.#settle(pending);
    const sent = await this.#connection.control
      .send(
        {
          text: outgoing.text,
          whenBusy: outgoing.mode === 'queue' ? 'followUp' : 'steer',
          requestId: crypto.randomUUID(),
          agentId: target || null,
          ...(attachments.length ? { attachments } : {}),
        },
        BACKGROUND_CONTEXT
      )
      .finally(() => pending && this.#settle(pending));
    if (!sent.accepted) throw new Error(sent.error.message);
    if (pending?.dropped)
      attempt(
        this.#connection.control.unqueue(pending.agentId, sent.submissionId, BACKGROUND_CONTEXT),
        'remove queued messages',
        this.#report(pending.agentId)
      );
  }

  #pending(agentId: string, outgoing: Outgoing): Pending {
    const id = `p${crypto.randomUUID()}`;
    const message: UserMessage = {
      id,
      role: 'user',
      text: outgoing.text,
      createdAt: Date.now(),
      ...(outgoing.attachments?.length ? { attachments: [...outgoing.attachments] } : {}),
      queued: true,
      mode: outgoing.mode === 'queue' ? 'queue' : 'steer',
    };
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const pending = { agentId, message, dropped: false, release, released };
    this.#outbox.set(id, pending);
    this.emit('messages', agentId);
    return pending;
  }

  #settle(pending: Pending): void {
    this.#outbox.delete(pending.message.id);
    this.emit('messages', pending.agentId);
  }

  async rewind(agentId: string, messageId: string): Promise<Outgoing | null> {
    const rewound = await this.#connection.control.rewindAgent(
      agentId,
      messageId,
      BACKGROUND_CONTEXT
    );
    if (!rewound.done) return null;
    return rewound.attachments?.length
      ? { text: rewound.text, attachments: rewound.attachments }
      : { text: rewound.text };
  }

  stop(agentId: string = this.active()): void {
    attempt(
      this.#connection.control.stopAgent(agentId, BACKGROUND_CONTEXT),
      'stop agents',
      this.#report(agentId)
    );
  }

  busy(agentId: string = this.active()): boolean {
    return isBusy(this.#view(agentId)) || this.#held(agentId);
  }

  #status(agentId: string, shown: AgentStatus): AgentStatus {
    return shown === 'idle' && this.#held(agentId) ? 'working' : shown;
  }

  #held(agentId: string): boolean {
    return this.#hold !== null && agentId === (this.#connection.agents?.value?.active ?? CONE);
  }

  queue(agentId: string = this.active()): readonly UserMessage[] {
    const pending = [...this.#outbox.values()]
      .filter((item) => item.agentId === agentId && !item.dropped)
      .map((item) => item.message);
    return [...queued(this.#view(agentId)), ...pending];
  }

  unqueue(agentId: string, messageId: string): void {
    const pending = this.#outbox.get(messageId);
    if (pending) {
      pending.dropped = true;
      pending.release();
      this.emit('messages', pending.agentId);
      return;
    }
    attempt(
      this.#connection.control.unqueue(agentId, messageId.replace(/^q/, ''), BACKGROUND_CONTEXT),
      'remove queued messages',
      this.#report(agentId)
    );
  }

  suggestion(): string | null {
    return null;
  }

  answer(): void {}

  resolveLick(agentId: string, messageId: string, state: 'confirmed' | 'dismissed'): void {
    const message = this.messages(agentId).find((candidate) => candidate.id === messageId);
    const entry = this.#view(agentId)?.entries.find(
      (candidate) => `e${candidate.id}` === messageId
    );
    const lick = message?.role === 'lick' && entry ? entryLick(entry) : undefined;
    if (lick)
      attempt(
        this.#connection.control.resolveAgentLick(agentId, lick.id, state, BACKGROUND_CONTEXT),
        'answer licks',
        this.#report(agentId)
      );
  }

  compact(agentId: string = this.active()): void {
    attempt(
      this.#connection.control.compactAgent(agentId, null, BACKGROUND_CONTEXT),
      'compact conversations',
      this.#report(agentId)
    );
  }

  clear(agentId: string = this.active()): void {
    attempt(
      this.#connection.control.newChat(agentId, BACKGROUND_CONTEXT),
      'start new chats',
      this.#report(agentId)
    );
  }

  freeze(agentId: string = this.active()): void {
    attempt(
      this.#connection.control.freeze(agentId, BACKGROUND_CONTEXT),
      'freeze cones',
      this.#report(agentId)
    );
  }

  #configure(agentId: string, change: Partial<AgentSettingsChange>): void {
    attempt(
      this.#connection.control.configure(
        {
          model: change.model ?? null,
          thinkingLevel: change.thinkingLevel ?? null,
          agentId,
        },
        BACKGROUND_CONTEXT
      ),
      'change agent settings',
      this.#report(agentId)
    );
  }

  setModel(agentId: string, model: string): void {
    const at = model.indexOf('/');
    if (at <= 0) return;
    this.#configure(agentId, {
      model: { provider: model.slice(0, at), modelId: model.slice(at + 1) },
    });
  }

  setThinking(agentId: string, level: Thinking): void {
    this.#configure(agentId, { thinkingLevel: level });
  }

  async older(): Promise<readonly Message[]> {
    return [];
  }

  commands(): readonly SlashCommand[] {
    return (this.#connection.commands?.value ?? []).map(slashCommand);
  }

  createScoop(parentId: string, name: string): Agent {
    const provisional = `scoop:creating-${crypto.randomUUID()}`;
    const created = this.#connection.control.createScoop(parentId, name, BACKGROUND_CONTEXT).then(
      (result) => result.id,
      () => null
    );
    this.#creating.set(provisional, created);
    void created.then((id) => {
      if (this.#active !== provisional) return;
      this.#active = id ?? parentId;
      this.emit('active', this.#active);
      this.emit('messages', this.#active);
    });
    return {
      id: provisional,
      name,
      kind: 'scoop',
      parentId,
      status: 'idle',
      model: '',
      contextFill: 0,
      unread: 0,
    };
  }

  async drop(agentId: string): Promise<void> {
    const parent = this.#summary().find((summary) => summary.id === agentId)?.parentId ?? CONE;
    const dropped = await this.#connection.control.drop(agentId, BACKGROUND_CONTEXT);
    if (dropped.error !== null) throw new Error(dropped.error);
    if (this.#active === agentId) this.select(parent);
  }

  async createCone(name: string): Promise<Agent> {
    const created = await this.#connection.control.createCone(name, BACKGROUND_CONTEXT);
    if (created.error !== null) throw new Error(created.error);
    return {
      id: created.id,
      name: name.trim(),
      kind: 'cone',
      parentId: null,
      status: 'idle',
      model: '',
      contextFill: 0,
      unread: 0,
    };
  }

  frozen(): readonly FrozenCone[] {
    return (this.#connection.frozen?.value ?? []).map(
      ({ id, name, title, model, messages, frozenAt, kind, live, thawedAs }) => ({
        id,
        name,
        title,
        model,
        messages,
        frozenAt,
        kind,
        live,
        ...(thawedAs ? { thawedAs } : {}),
      })
    );
  }

  thaw(id: string): Agent | null {
    const record = this.frozen().find((item) => item.id === id);
    if (!record) return null;
    if (record.live) {
      const running = this.list().find((agent) => agent.id === id) ?? null;
      if (running) this.select(id);
      return running;
    }
    const provisional = `thawing-${crypto.randomUUID()}`;
    const thawed = this.#connection.control.thaw(id, BACKGROUND_CONTEXT).then(
      (result) => result.id,
      () => null
    );
    this.#creating.set(provisional, thawed);
    void thawed.then((cone) => {
      if (this.#active !== provisional) return;
      this.#active = cone ?? CONE;
      this.emit('active', this.#active);
      this.emit('messages', this.#active);
    });
    return {
      id: provisional,
      name: record.name,
      kind: 'cone',
      parentId: null,
      status: 'idle',
      model: record.model,
      contextFill: 0,
      unread: 0,
    };
  }

  discard(id: string): void {
    attempt(
      this.#connection.control.discard(id, BACKGROUND_CONTEXT),
      'discard frozen cones',
      this.#report(this.active())
    );
  }
}

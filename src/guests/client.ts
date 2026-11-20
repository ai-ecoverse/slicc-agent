import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import type { ConversationView } from '@earendil-works/pi-durable';
import { type AgentConnection, handshake } from '../client.ts';
import {
  type AgentControl,
  AgentGuestService,
  type AgentSettings,
  CONTROL_METHODS,
  type GUEST_METHODS,
  type GuestProposal,
  type GuestShown,
  type SendResponse,
  type SettingsState,
} from '../services.ts';
import { plain, type Remote } from '../serving.ts';
import { createState } from '../state.ts';
import type { PortEndpoint } from '../wire.ts';
import type { GuestOpened, Proposed, ProposeRequest } from './index.ts';

export const GUEST_ONLY = 'a guest can only watch and send messages';
export const SEAT_REFUSED = "This guest link isn't valid any more.";

const SAID: Record<string, string> = {
  revoked: 'This guest seat was revoked.',
  empty: 'There is nothing to send.',
  'too-long': 'That message is too long for a guest seat.',
  gone: 'The cone this seat shares is gone.',
  unavailable: "Messages from guests need a review, and this agent can't review them yet.",
  overflow: 'Too many of your messages are waiting for approval. Try again once one is answered.',
};

export const proposedSentence = (reason: string): string =>
  SAID[reason] ?? 'The message was not delivered.';

const refusal = (message: string, code = 'EACCES') => Object.assign(new Error(message), { code });

export interface GuestConnection extends AgentConnection {
  readonly guest: GuestShown;
  propose(request: ProposeRequest): Promise<Proposed>;
}

const seatRefused = (error: unknown): unknown =>
  (error as { code?: unknown } | null)?.code === 'EVERSION' ? error : refusal(SEAT_REFUSED);

export async function connectGuest(endpoint: PortEndpoint): Promise<GuestConnection> {
  const { client, handles } = await handshake(endpoint, [AgentGuestService], seatRefused);
  const handle = handles[0] as Remote;
  if (handle.variant !== 'guest') {
    await client.close();
    throw handle.refused ?? refusal(SEAT_REFUSED);
  }
  const call =
    <T>(name: (typeof GUEST_METHODS)[number]) =>
    async (...args: unknown[]): Promise<T> => {
      const method = handle[name] as (args: unknown[], context: Context) => Promise<T>;
      try {
        return await method(args, BACKGROUND_CONTEXT);
      } catch (error) {
        throw plain(error);
      }
    };
  const propose = (request: ProposeRequest) => call<Proposed>('propose')(request);
  const seat = client.follow<GuestShown>(handle.seat);
  const guest = seat.value;
  const refuse = () => Promise.reject(refusal(GUEST_ONLY));
  const control = Object.fromEntries(
    CONTROL_METHODS.map((name) => [name, refuse])
  ) as unknown as AgentControl;
  control.guestOpen = (draft) => call<GuestOpened>('guestOpen')(draft);
  control.guestRevoke = (id) => call<{ revoked: boolean }>('guestRevoke')(id);
  control.send = async (request): Promise<SendResponse> => {
    if (request.attachments?.length)
      return {
        accepted: false,
        submissionId: null,
        error: { code: 'EACCES', message: "A guest can't attach files." },
      };
    const proposed = await propose({ text: request.text, requestId: request.requestId });
    if (proposed.state === 'submitted')
      return { accepted: true, submissionId: proposed.submissionId, error: null };
    if (proposed.state === 'queued')
      return { accepted: true, submissionId: proposed.review, error: null };
    return {
      accepted: false,
      submissionId: null,
      error: { code: 'EACCES', message: proposedSentence(proposed.reason) },
    };
  };
  const closed = client.link.ended;
  const settings: AgentSettings = {
    state: createState<SettingsState>({ models: [], accounts: [] }),
    connect: refuse,
    disconnect: refuse,
    remove: refuse,
    serverUrl: refuse,
    signIn: refuse,
    dismissMoved: refuse,
    addServer: refuse,
    removeServer: refuse,
    refusals: refuse,
  };
  return {
    serverId: client.serverId,
    guest,
    control,
    transcript: client.follow<ConversationView>(handle.transcript),
    proposals: client.follow<GuestProposal[]>(handle.proposals),
    deliveries: createState({}),
    agents: createState({
      active: guest.agentId,
      agents: [
        { id: guest.agentId, name: guest.name, kind: 'cone' as const, parentId: null, role: null },
      ],
    }),
    settings,
    closed,
    propose,
    prompt: refuse,
    webhook: refuse,
    approvalRunNotice: refuse,
    async close() {
      await client.close();
      await closed;
    },
  };
}

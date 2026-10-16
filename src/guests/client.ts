import { createHost, isChordError, type Readable, replicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import { type AgentConnection, final, lasting } from '../client.ts';
import {
  type AgentControl,
  AgentGuestService,
  type AgentSettings,
  CONTROL_METHODS,
  type GUEST_METHODS,
  type GuestProposal,
  type GuestShown,
  type SendResponse,
} from '../services.ts';
import { AGENT_HOST, kept, plain, type Remote, replicated } from '../serving.ts';
import { type PortEndpoint, PortLink } from '../wire.ts';
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

export async function connectGuest(endpoint: PortEndpoint): Promise<GuestConnection> {
  const link = new PortLink(endpoint);
  let serverId: string;
  try {
    serverId = await link.hello;
  } catch {
    throw refusal(SEAT_REFUSED);
  }
  const host = createHost({ name: `guest:${crypto.randomUUID()}`, kind: 'client' });
  host.connect(link);
  const handle = host.get(AgentGuestService, {}, { at: AGENT_HOST }) as unknown as Remote;
  const fail = async (error: unknown): Promise<never> => {
    handle.release();
    link.close('handshake failed');
    await host.close();
    throw error;
  };
  try {
    await Promise.race([
      handle.ready,
      link.ended.then(() => {
        throw refusal(SEAT_REFUSED);
      }),
    ]);
  } catch (error) {
    return fail(
      isChordError(error) && error.code === 'forbidden' ? refusal(SEAT_REFUSED) : final(error)
    );
  }
  if (handle.kind !== 'guest') return fail(refusal(SEAT_REFUSED));
  const transcriptMember = handle.transcript as Readable<ConversationView | undefined>;
  const seatMember = handle.seat as Readable<GuestShown | undefined>;
  const proposalsMember = handle.proposals as Readable<GuestProposal[] | undefined>;
  const keeping = [transcriptMember, seatMember, proposalsMember].map(kept);
  await Promise.race([Promise.all(keeping.map((keep) => keep.ready)), link.ended]);
  const through =
    <T>(name: (typeof GUEST_METHODS)[number]) =>
    async (...args: unknown[]): Promise<T> => {
      const call = handle[name] as (args: unknown[], ctx: unknown) => Promise<T>;
      try {
        return await host.root((ctx) => call(args, ctx), {});
      } catch (error) {
        throw plain(error);
      }
    };
  const propose = (request: ProposeRequest) => through<Proposed>('propose')(request);
  const guest = seatMember.value as GuestShown;
  const refuse = () => Promise.reject(refusal(GUEST_ONLY));
  const control = Object.fromEntries(
    CONTROL_METHODS.map((name) => [name, refuse])
  ) as unknown as AgentControl;
  control.guestOpen = (draft) => through<GuestOpened>('guestOpen')(draft);
  control.guestRevoke = (id) => through<{ revoked: boolean }>('guestRevoke')(id);
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
  const transcript = lasting(replicated(transcriptMember));
  const proposals = lasting(replicated(proposalsMember));
  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    transcript.freeze();
    proposals.freeze();
    for (const keep of keeping) keep.stop();
    handle.release();
  };
  const closed = link.ended.then((reason) => {
    finish();
    return reason;
  });
  const settings: AgentSettings = {
    state: replicatedState({ models: [], accounts: [] }),
    connect: refuse,
    disconnect: refuse,
    signIn: refuse,
    dismissMoved: refuse,
  };
  return {
    serverId,
    guest,
    control,
    transcript: transcript.state,
    proposals: proposals.state,
    deliveries: replicatedState({}),
    agents: replicatedState({
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
    async close() {
      finish();
      link.close('closed');
      await closed;
      await host.close();
    },
  };
}

import type { Context, Host, ReplicatedState } from '@earendil-works/chord';
import { forbidden, replicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { AgentGuest, GuestProposal, GuestShown } from '../services.ts';
import type { AgentPrincipal, GuestPrincipal } from '../serving.ts';
import { type PortEndpoint, PortLink } from '../wire.ts';
import type { Guests } from './index.ts';
import { GUESTS_MANAGE_DENIED, GUESTS_MANAGE_LATER } from './policy.ts';
import type { ReviewsState } from './review.ts';
import { guestView } from './view.ts';

export function proposalsOf(state: ReviewsState | null | undefined, seat: string): GuestProposal[] {
  return Object.values(state?.reviews ?? {})
    .filter((review) => review.seat === seat)
    .sort((a, b) => a.n - b.n)
    .map((review) => ({
      id: review.id,
      text: review.text,
      state: review.state,
      reason: review.reason,
      createdAt: review.createdAt,
      decidedAt: review.decidedAt,
    }));
}

const managing = (guests: Pick<Guests, 'policy'>): Promise<never> =>
  Promise.reject(
    forbidden(guests.policy().manageGuests === 'deny' ? GUESTS_MANAGE_DENIED : GUESTS_MANAGE_LATER)
  );

export function guestOpener(
  guests: Guests,
  agents: Pick<Agents, 'state'>,
  views: ReplicatedState<Record<string, ConversationView>>,
  context: Context
) {
  return (principal: GuestPrincipal): { value: AgentGuest; dispose(): void } | undefined => {
    const record = guests.current(principal);
    if (!record) return undefined;
    const pick = (all: Record<string, ConversationView> | undefined) => all?.[record.agentId];
    let shown = pick(views.value);
    const transcript = replicatedState<ConversationView>(guestView(shown, record.id));
    const off = views.subscribe((all) => {
      if (pick(all) === shown) return;
      shown = pick(all);
      transcript.replace(context, guestView(shown, record.id));
    });
    const seat = replicatedState<GuestShown>({
      id: record.id,
      label: record.label,
      agentId: record.agentId,
      name: agents.state().cones[record.agentId]?.name ?? record.agentId,
      expiresAt: record.expiresAt,
      gates: { ...record.gates },
    });
    let listed = JSON.stringify(proposalsOf(guests.reviews.value, record.id));
    const proposals = replicatedState<GuestProposal[]>(JSON.parse(listed) as GuestProposal[]);
    const offProposals = guests.reviews.subscribe((state) => {
      const next = JSON.stringify(proposalsOf(state, record.id));
      if (next === listed) return;
      listed = next;
      proposals.replace(context, JSON.parse(next) as GuestProposal[]);
    });
    return {
      value: {
        transcript,
        seat,
        proposals,
        propose: (request, using) => guests.propose(principal, request, using),
        guestOpen: () => managing(guests),
        guestRevoke: () => managing(guests),
      },
      dispose() {
        off();
        offProposals();
      },
    };
  };
}

export function admitGuest(
  guests: Guests,
  endpoint: PortEndpoint,
  asked: { id: string; label: string },
  serverId: string,
  link: number,
  host: Pick<Host, 'accept'>
): void {
  const port = new PortLink(endpoint);
  const guest = guests.admit(String(asked.id), String(asked.label));
  if (!guest) {
    port.close('this guest seat is not valid');
    return;
  }
  void port.ended.then(guests.joined(guest.id));
  port.greet(serverId);
  host.accept(port, { principal: { seat: 'guest', link, guest } satisfies AgentPrincipal });
}

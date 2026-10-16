import type { Context, Host, ReplicatedState } from '@earendil-works/chord';
import { forbidden, replicatedState } from '@earendil-works/chord';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import type { Approval } from '../approvals/index.ts';
import type { AgentGuest, GuestProposal, GuestShown } from '../services.ts';
import type { AgentPrincipal, GuestPrincipal } from '../serving.ts';
import { type PortEndpoint, PortLink } from '../wire.ts';
import type { Guests } from './index.ts';
import { GUESTS_MANAGE_DENIED, GUESTS_MANAGE_LATER } from './policy.ts';
import { guestView } from './view.ts';

export function proposalsOf(items: readonly Approval[] | undefined, seat: string): GuestProposal[] {
  return (items ?? [])
    .filter((item) => item.kind === 'guest-message' && item.seat === seat)
    .map((item) => ({
      id: item.id,
      text: (item.detail as { text?: string }).text ?? '',
      state: item.state,
      reason: item.reason ?? null,
      createdAt: item.createdAt,
      decidedAt: item.decidedAt ?? null,
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
  context: Context,
  approvals?: ReplicatedState<Approval[]>
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
    let listed = JSON.stringify(proposalsOf(approvals?.value, record.id));
    const proposals = replicatedState<GuestProposal[]>(JSON.parse(listed) as GuestProposal[]);
    const offProposals = approvals?.subscribe((items) => {
      const next = JSON.stringify(proposalsOf(items, record.id));
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
        offProposals?.();
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

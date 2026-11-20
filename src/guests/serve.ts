import { ChordError, type Ctx, forbidden, type Host } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord/json';
import type { ConversationView } from '@earendil-works/pi-durable';
import type { Agents } from '../agents.ts';
import { MAX_FRAME } from '../link.ts';
import { type AgentGuest, type GuestProposal, type GuestShown, helloOf } from '../services.ts';
import type { AgentPrincipal, GuestPrincipal, LinkCalls, Served } from '../serving.ts';
import { createState, type State } from '../state.ts';
import { type PortEndpoint, PortLink, refuse, SEAT } from '../wire.ts';
import type { Guests } from './index.ts';
import { GUESTS_MANAGE_DENIED, GUESTS_MANAGE_LATER } from './policy.ts';
import type { ReviewsState } from './review.ts';
import { guestView } from './view.ts';

export const GUEST_CALLS = 4;

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
  views: State<Record<string, ConversationView>>,
  context: Context
) {
  return (principal: GuestPrincipal): { value: AgentGuest; dispose(): void } | undefined => {
    const record = guests.current(principal);
    if (!record) return undefined;
    const pick = (all: Record<string, ConversationView> | undefined) => all?.[record.agentId];
    let shown = pick(views.value);
    const transcript = createState<ConversationView>(guestView(shown, record.id));
    const off = views.subscribe((all) => {
      if (pick(all) === shown) return;
      shown = pick(all);
      transcript.replace(context, guestView(shown, record.id));
    });
    const seat = createState<GuestShown>({
      id: record.id,
      label: record.label,
      agentId: record.agentId,
      name: agents.state().cones[record.agentId]?.name ?? record.agentId,
      expiresAt: record.expiresAt,
      gates: { ...record.gates },
    });
    let listed = JSON.stringify(proposalsOf(guests.reviews.value, record.id));
    const proposals = createState<GuestProposal[]>(JSON.parse(listed) as GuestProposal[]);
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

export const TOO_MANY_CALLS = `Too many calls in progress on this connection (${GUEST_CALLS})`;

export function limited(methods: Served, calls: LinkCalls): Served {
  return Object.fromEntries(
    Object.entries(methods).map(([name, call]) => [
      name,
      async (args: unknown[], ctx: Ctx) => {
        if (calls.running >= calls.max)
          throw new ChordError({ code: 'unavailable', reason: 'busy', message: TOO_MANY_CALLS });
        calls.running += 1;
        try {
          return await call(args, ctx);
        } finally {
          calls.running -= 1;
        }
      },
    ])
  );
}

export function admitGuest(
  guests: Guests,
  endpoint: PortEndpoint,
  asked: { id: string; label: string },
  serverId: string,
  link: number,
  host: Pick<Host<AgentPrincipal, JsonValue>, 'accept'>,
  context: Context
): void {
  const guest = guests.admit(String(asked.id), String(asked.label));
  if (!guest) {
    refuse(endpoint, SEAT);
    return;
  }
  const port = new PortLink(endpoint, helloOf(serverId));
  void port.ended.then(guests.joined(guest.id));
  const calls: LinkCalls = { running: 0, max: GUEST_CALLS };
  host.accept(
    port,
    {
      principal: { kind: 'guest', link, guest, calls },
      limits: { part: MAX_FRAME, decoded: MAX_FRAME },
    },
    context
  );
}

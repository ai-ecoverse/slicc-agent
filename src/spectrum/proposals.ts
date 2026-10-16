import type { Message, SystemMessage, UserMessage } from '@ai-ecoverse/slicc-spectrum/ui';
import type { GuestProposal } from '../services.ts';

export const APPROVED = 'It was approved.';
export const UNANSWERED = 'Nobody approved this in time.';
export const DECLINED = 'It was declined.';
export const WITHDRAWN = 'It was withdrawn.';

const ENDED: Record<string, string> = {
  approved: APPROVED,
  unanswered: UNANSWERED,
  rejected: DECLINED,
  withdrawn: WITHDRAWN,
};

export function proposalQueue(
  proposals: readonly GuestProposal[] | undefined,
  label: string,
  seat: string
): UserMessage[] {
  return (proposals ?? [])
    .filter((proposal) => proposal.state === 'pending' || proposal.state === 'queued')
    .map((proposal) => ({
      id: `g${proposal.id}`,
      role: 'user',
      text: proposal.text,
      createdAt: proposal.createdAt,
      queued: true,
      mode: 'queue',
      from: label,
      origin: 'guest',
      seat,
    }));
}

export function proposalNotices(proposals: readonly GuestProposal[] | undefined): SystemMessage[] {
  return (proposals ?? []).flatMap((proposal) => {
    const title = ENDED[proposal.state];
    if (!title) return [];
    return [
      {
        id: `g${proposal.id}`,
        role: 'system',
        kind: 'notice',
        title,
        text: proposal.text,
        createdAt: proposal.decidedAt ?? proposal.createdAt,
      },
    ];
  });
}

export function merged(messages: readonly Message[], notices: readonly SystemMessage[]): Message[] {
  if (!notices.length) return [...messages];
  const out: Message[] = [];
  const left = [...notices].sort((a, b) => a.createdAt - b.createdAt);
  for (const message of messages) {
    while (left.length && (left[0] as SystemMessage).createdAt < message.createdAt)
      out.push(left.shift() as SystemMessage);
    out.push(message);
  }
  return [...out, ...left];
}

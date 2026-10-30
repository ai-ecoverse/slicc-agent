import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import { VIEW_ONLY } from './view-only.ts';

export { VIEW_ONLY };

export const NOT_OWNER = "Only the owner's page can change MCP servers.";
export const REFUSALS_OWNER = "Only the owner's page can see why MCP servers were refused.";

type Answer = (...args: unknown[]) => Promise<unknown>;

const refuse: Answer = () =>
  Promise.reject(Object.assign(new Error(VIEW_ONLY), { code: 'EACCES' }));

const refused: Answer = async () => ({
  accepted: false as const,
  submissionId: null,
  error: { code: 'EACCES', message: VIEW_ONLY },
});

const sends = new Set(['send', 'compact', 'compactAgent']);

export const controlAnswer = (name: string): Answer => (sends.has(name) ? refused : refuse);

const notOwner: Answer = async () => ({ ok: false, code: 'not-owner', reason: NOT_OWNER });

const noRefusals: Answer = () =>
  Promise.reject(Object.assign(new Error(REFUSALS_OWNER), { code: 'EACCES' }));

const settingsAnswers: Record<string, Answer> = {
  addServer: notOwner,
  removeServer: notOwner,
  refusals: noRefusals,
};

export const settingsAnswer = (name: string): Answer => settingsAnswers[name] ?? refuse;

export const remoteAnswer = (name: string): Answer =>
  name === 'prompt' ? async () => ({ ok: false, code: 'EACCES', message: VIEW_ONLY }) : refuse;

export function viewPages(): AgentPages {
  return {
    open: async () => ({ error: VIEW_ONLY }),
    report: async () => {},
    next: async () => ({ requests: [], done: true }),
    answer: async () => {},
    close: async () => {},
  };
}

export const pageAnswer = (name: string): Answer =>
  (viewPages() as unknown as Record<string, Answer>)[name] as Answer;

export function viewRemote(remote: AgentRemote): Pick<AgentRemote, 'watch' | 'next' | 'close'> {
  const mine = new Set<string>();
  return {
    async watch(request, context) {
      const opened = await remote.watch(request, context);
      if (opened.ok) mine.add(opened.stream);
      return opened;
    },
    async next(stream, waitMs, context) {
      if (!mine.has(stream)) return { events: [], done: true };
      const batch = await remote.next(stream, waitMs, context);
      if (batch.done) mine.delete(stream);
      return batch;
    },
    async close(stream, context) {
      if (!mine.delete(stream)) return;
      await remote.close(stream, context);
    },
  };
}

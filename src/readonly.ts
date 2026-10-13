import { ServerError } from '@earendil-works/pi-server';
import type { AgentRemote } from './remote/host.ts';
import type { AgentPages } from './remote/pages.ts';
import type { AgentControl, AgentSettings } from './services.ts';
import { VIEW_ONLY } from './view-only.ts';

export { VIEW_ONLY };

const READS = new Set<keyof AgentControl>([
  'wait',
  'changesOpen',
  'monitorOpen',
  'monitorClose',
  'image',
]);

function refuse(): Promise<never> {
  return Promise.reject(new ServerError('EACCES' as never, VIEW_ONLY));
}

const refused = async () => ({
  accepted: false as const,
  submissionId: null,
  error: { code: 'EACCES', message: VIEW_ONLY },
});

const ANSWERS: Partial<Record<keyof AgentControl, () => Promise<unknown>>> = {
  send: refused,
  compact: refused,
  compactAgent: refused,
};

export function viewControl(control: AgentControl): AgentControl {
  const view: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(control))
    view[key] =
      typeof value !== 'function' || READS.has(key as keyof AgentControl)
        ? value
        : (ANSWERS[key as keyof AgentControl] ?? refuse);
  return view as unknown as AgentControl;
}

export function viewSettings(settings: AgentSettings): AgentSettings {
  return { state: settings.state, connect: refuse, disconnect: refuse, signIn: refuse };
}

export function viewPages(): AgentPages {
  return {
    open: async () => ({ error: VIEW_ONLY }),
    report: async () => {},
    next: async () => ({ requests: [], done: true }),
    answer: async () => {},
    close: async () => {},
  };
}

export function viewRemote(remote: AgentRemote): AgentRemote {
  const mine = new Set<string>();
  return {
    prompt: async () => ({ ok: false, code: 'EACCES', message: VIEW_ONLY }),
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
    abort: refuse,
  };
}

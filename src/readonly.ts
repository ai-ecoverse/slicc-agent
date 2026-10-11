import { ServerError } from '@earendil-works/pi-server';
import type { AgentRemote } from './remote/host.ts';
import type { AgentControl, AgentSettings } from './services.ts';

export const VIEW_ONLY = 'this follower can watch, but not send, steer or abort';

const READS = new Set<keyof AgentControl>(['wait', 'changesOpen']);

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

export function viewRemote(remote: AgentRemote): AgentRemote {
  return {
    prompt: async () => ({ ok: false, code: 'EACCES', message: VIEW_ONLY }),
    watch: (request, context) => remote.watch(request, context),
    next: (stream, waitMs, context) => remote.next(stream, waitMs, context),
    close: (stream, context) => remote.close(stream, context),
    abort: refuse,
  };
}

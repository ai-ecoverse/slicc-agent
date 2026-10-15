import { replicatedState } from '@earendil-works/chord';
import type { AgentConnection } from './client.ts';

export const NEWER_AGENT =
  "That SLICC runs a newer version of the agent than this one, so this tab can't follow it. Update this SLICC, then reload this page.";

export function mismatched(serverId: string): AgentConnection {
  const notice = NEWER_AGENT;
  const refuse = () => Promise.reject(Object.assign(new Error(notice), { code: 'EPROTO' }));
  const control = new Proxy({}, { get: () => refuse }) as AgentConnection['control'];
  let ended!: (reason: undefined) => void;
  const closed = new Promise<undefined>((resolve) => {
    ended = resolve;
  });
  return {
    serverId,
    mismatch: notice,
    control,
    transcript: replicatedState({ conversation: {} as never, entries: [], docs: {} }),
    deliveries: replicatedState({}),
    settings: {
      state: replicatedState({ models: [], accounts: [] }),
      connect: refuse,
      disconnect: refuse,
      signIn: refuse,
      dismissMoved: refuse,
    },
    closed,
    prompt: refuse,
    webhook: refuse,
    async close() {
      ended(undefined);
    },
  };
}

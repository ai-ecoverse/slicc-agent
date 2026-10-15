import { replicatedState } from '@earendil-works/chord';
import type { AgentConnection } from './client.ts';
import { LINK_PROTOCOL } from './wire.ts';

export function mismatchNotice(protocol: number): string {
  const version =
    protocol < LINK_PROTOCOL ? 'an older' : protocol > LINK_PROTOCOL ? 'a newer' : 'another';
  const update =
    protocol < LINK_PROTOCOL
      ? 'Update that SLICC'
      : protocol > LINK_PROTOCOL
        ? 'Update this SLICC'
        : 'Update both SLICCs';
  return `That SLICC runs ${version} version of the agent than this one, so this tab can't follow it. ${update}, then reload this page.`;
}

export function mismatched(serverId: string, protocol: number): AgentConnection {
  const notice = mismatchNotice(protocol);
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

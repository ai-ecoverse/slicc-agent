import { createHost, method, remote } from '@earendil-works/chord';
import { Type } from 'typebox';
import { AGENT_HOST, principalKey } from '../../../src/serving.ts';
import { PortLink } from '../../../src/wire.ts';

const later = (name) =>
  remote(name, {
    version: 99,
    input: Type.Object({}),
    variants: { later: { methods: { ping: method(Type.Unknown(), Type.Unknown()) } } },
  });

globalThis.otherOwner = (names) => {
  const host = createHost({ name: AGENT_HOST, principalKey });
  for (const name of names)
    host.serve(later(name), () => ({ kind: 'later', ping: async () => null }));
  const links = [];
  return {
    links,
    port(seat) {
      const { port1, port2 } = new MessageChannel();
      const link = new PortLink(port1);
      links.push(link);
      link.greet('other-owner');
      host.accept(link, { principal: seat });
      return port2;
    },
    close: () => host.close(),
  };
};

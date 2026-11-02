import { createHost, hostNamed, method, remote } from '@earendil-works/chord';
import { obj, unknown } from '@earendil-works/pi-schema';
import { AGENT_HOST, principalKey, SELF } from '../../../src/serving.ts';
import { PortLink } from '../../../src/wire.ts';

const later = (name) =>
  remote(name, {
    version: 99,
    input: obj({}),
    host: hostNamed(AGENT_HOST),
    variants: { later: { methods: { ping: method(unknown(), unknown()) } } },
  });

globalThis.otherOwner = (names) => {
  const host = createHost({ name: AGENT_HOST, self: SELF, principalKey });
  for (const name of names)
    host.serve(later(name), () => ({ variant: 'later', ping: async () => null }));
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

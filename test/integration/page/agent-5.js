import { connectAgent, connectGuest } from 'slicc-agent-5/page';
import { PortLink } from '../../../node_modules/slicc-agent-5/dist/wire.js';
import { createHost } from '../../../node_modules/slicc-agent-5/node_modules/@earendil-works/chord/dist/index.js';

globalThis.oldConnectAgent = connectAgent;
globalThis.oldConnectGuest = connectGuest;
globalThis.oldOwner = () => {
  const host = createHost({ name: 'agent' });
  const links = [];
  return {
    links,
    port(principal) {
      const { port1, port2 } = new MessageChannel();
      const link = new PortLink(port1);
      links.push(link);
      link.greet('old-owner');
      host.accept(link, { principal });
      return port2;
    },
    close: () => host.close(),
  };
};

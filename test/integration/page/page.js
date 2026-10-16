import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { startAgent } from '../../../src/index.ts';
import { bridgePort, connectAgent, connectGuest, linkEndpoint } from '../../../src/page.ts';
import { remoteControl } from '../../../src/remote/client.ts';
import { createAgentModel } from '../../../src/spectrum/index.ts';

globalThis.startAgent = startAgent;
globalThis.createAgentModel = createAgentModel;
globalThis.BACKGROUND_CONTEXT = BACKGROUND_CONTEXT;
globalThis.remoteControl = remoteControl;
globalThis.connectAgent = connectAgent;
globalThis.connectGuest = connectGuest;
globalThis.bridgePort = bridgePort;
globalThis.linkEndpoint = linkEndpoint;

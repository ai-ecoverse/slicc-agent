import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { connectAgent, startAgent } from '../../../src/index.ts';
import { remoteControl } from '../../../src/remote/client.ts';
import { createAgentModel } from '../../../src/spectrum/index.ts';

globalThis.startAgent = startAgent;
globalThis.createAgentModel = createAgentModel;
globalThis.BACKGROUND_CONTEXT = BACKGROUND_CONTEXT;
globalThis.remoteControl = remoteControl;
globalThis.connectAgent = connectAgent;

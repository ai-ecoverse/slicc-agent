import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { startAgent } from '../../../src/index.ts';
import { createAgentModel } from '../../../src/spectrum/index.ts';

globalThis.startAgent = startAgent;
globalThis.createAgentModel = createAgentModel;
globalThis.BACKGROUND_CONTEXT = BACKGROUND_CONTEXT;

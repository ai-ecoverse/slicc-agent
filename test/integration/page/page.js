import { startAgent } from '../../../src/index.ts';
import { createAgentModel } from '../../../src/spectrum/index.ts';

globalThis.startAgent = startAgent;
globalThis.createAgentModel = createAgentModel;

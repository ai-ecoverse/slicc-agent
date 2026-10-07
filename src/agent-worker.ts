import { type AgentWorkerScope, runAgentWorker } from './main.ts';

export const host = runAgentWorker(globalThis as unknown as AgentWorkerScope);

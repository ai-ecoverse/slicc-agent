import type { Agent } from './agent.ts';

export interface AgentRequest {
  id: number;
  prompt: string;
}

export type AgentReply = { id: number; text: string } | { id: number; error: string };

export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
}

function isRequest(data: unknown): data is AgentRequest {
  const value = data as Partial<AgentRequest> | null;
  return typeof value?.id === 'number' && typeof value.prompt === 'string';
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function serveAgent(endpoint: MessageEndpoint, agent: Promise<Agent>): void {
  endpoint.addEventListener('message', ({ data }) => {
    if (!isRequest(data)) return;
    agent
      .then((ready) => ready.prompt(data.prompt))
      .then(
        (text) => endpoint.postMessage({ id: data.id, text } satisfies AgentReply),
        (error: unknown) =>
          endpoint.postMessage({ id: data.id, error: reason(error) } satisfies AgentReply)
      );
  });
  endpoint.start?.();
}

export interface AgentClient {
  prompt(text: string): Promise<string>;
}

export function connectAgent(endpoint: MessageEndpoint): AgentClient {
  const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
  let next = 0;
  endpoint.addEventListener('message', ({ data }) => {
    const reply = data as AgentReply;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    if ('error' in reply) call.reject(new Error(reply.error));
    else call.resolve(reply.text);
  });
  endpoint.start?.();
  return {
    prompt(text) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        endpoint.postMessage({ id, prompt: text } satisfies AgentRequest);
      });
    },
  };
}

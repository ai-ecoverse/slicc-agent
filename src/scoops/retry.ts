export interface RetryAnswer {
  code: number;
  out: string;
}

const fail = (out: string): RetryAnswer => ({ code: 1, out: `agent: ${out}\n` });

export function retryEnded(id: string | undefined, fromAgent: boolean): RetryAnswer {
  if (fromAgent) return fail('only the user can ask about a stopped task');
  if (!id || !/^\d+$/.test(id)) return fail('usage: agent retry <task id>');
  return fail(
    `task ${id} cannot be resumed. A task that stops after repeated restarts has ended; submit the work again.`
  );
}

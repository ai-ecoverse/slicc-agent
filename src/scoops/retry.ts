import type { Context } from '@earendil-works/chord';
import type { Harness } from '@earendil-works/pi-durable';

export interface RetryAnswer {
  code: number;
  out: string;
}

const fail = (out: string): RetryAnswer => ({ code: 1, out: `agent: ${out}\n` });

export async function retryParked(
  harness: Pick<Harness, 'inspect' | 'retryTask'>,
  id: string | undefined,
  fromAgent: boolean,
  context: Context
): Promise<RetryAnswer> {
  if (fromAgent) return fail('only the user can run a parked task again');
  if (!id || !/^\d+$/.test(id)) return fail('usage: agent retry <task id>');
  const found = (await harness.inspect(context)).tasks.find(
    (task) => String(task.record.id) === id
  );
  if (!found) return fail(`there is no live task ${id}`);
  if (found.state.kind !== 'blocked' || found.state.reason !== 'restart_limit')
    return fail(`task ${id} isn't parked`);
  await harness.retryTask(found.record.id, context);
  return { code: 0, out: `task ${id} runs again\n` };
}

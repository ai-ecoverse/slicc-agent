import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { compactionHook, extractTask, idleWatch, scheduler, settingsReader } from './extract.ts';
import { contextSection, type Host, memorySection, memoryWriteTool } from './prompt.ts';
import { attachMemory, type MemoryAttach, type MemoryRuntime } from './runtime.ts';

export { MEMORY_WRITE, whoIs } from './prompt.ts';
export type { MemoryAttach, MemoryDraft, MemoryRuntime } from './runtime.ts';
export { USAGE } from './runtime.ts';

export const IDLE_CHECK_MS = 60_000;

export interface MemorySetup {
  extension: Extension;
  tools: readonly ToolRegistration[];
  extract(conversation: number, tail: number, context: Context): Promise<boolean>;
  attach(options: MemoryAttach, context: Context): Promise<MemoryRuntime>;
}

export function setupMemory(registry: Registry): MemorySetup {
  let connect: (host: Host) => void = () => undefined;
  const ready = new Promise<Host>((resolve) => {
    connect = resolve;
  });
  const tool = memoryWriteTool(ready);
  const settings = settingsReader(ready);
  const task = extractTask(ready, settings);
  const schedule = scheduler(ready, task, settings);
  const extension = defineExtension({
    name: 'slicc-memory',
    sections: [contextSection(ready), memorySection(ready)],
    tools: [tool],
    tasks: [task],
    hooks: [compactionHook(schedule)],
  });
  registry.install(extension);
  return {
    extension,
    tools: [tool],
    extract: schedule,
    async attach(options, context) {
      const runtime = await attachMemory(options, connect, context);
      const stop = idleWatch(
        await ready,
        schedule,
        settings,
        options.idleCheckMs ?? IDLE_CHECK_MS,
        context
      );
      return {
        ...runtime,
        async close(using) {
          stop();
          await runtime.close(using);
        },
      };
    },
  };
}

import type { Context } from '@earendil-works/chord';
import {
  defineExtension,
  type Extension,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { contextSection, type Host, memorySection, memoryWriteTool } from './prompt.ts';
import { attachMemory, type MemoryAttach, type MemoryRuntime } from './runtime.ts';

export { MEMORY_WRITE, whoIs } from './prompt.ts';
export type { MemoryAttach, MemoryDraft, MemoryRuntime } from './runtime.ts';
export { USAGE } from './runtime.ts';

export interface MemorySetup {
  extension: Extension;
  tools: readonly ToolRegistration[];
  attach(options: MemoryAttach, context: Context): Promise<MemoryRuntime>;
}

export function setupMemory(registry: Registry): MemorySetup {
  let connect: (host: Host) => void = () => undefined;
  const ready = new Promise<Host>((resolve) => {
    connect = resolve;
  });
  const tool = memoryWriteTool(ready);
  const extension = defineExtension({
    name: 'slicc-memory',
    sections: [contextSection(ready), memorySection(ready)],
    tools: [tool],
  });
  registry.install(extension);
  return {
    extension,
    tools: [tool],
    attach: (options, context) => attachMemory(options, connect, context),
  };
}

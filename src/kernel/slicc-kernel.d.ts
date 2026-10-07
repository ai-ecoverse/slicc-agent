declare module '@ai-ecoverse/slicc-kernel' {
  import type { Transport } from '../net.ts';
  import type { KernelClient } from './client.ts';

  export function attachKernel(
    port: MessagePort,
    options?: { timeoutMs?: number }
  ): Promise<
    KernelClient & { transport: Transport; close(options?: { kill?: boolean }): Promise<void> }
  >;
}

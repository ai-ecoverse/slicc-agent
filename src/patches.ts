import { Server } from '@earendil-works/pi-server';
import { withUnrefTimers } from './wire.ts';

const applied = Symbol.for('slicc.agent.patches');

export const MCP_SSE_PATCH = 'pi-mcp-sse-buffer';

interface Patchable {
  prototype: { accept: (...args: unknown[]) => unknown };
  [applied]?: true;
}

export function patchServerAccept(target: Patchable): void {
  if (target[applied]) return;
  const original = target.prototype.accept;
  if (typeof original !== 'function' || !String(original).includes('handshakeTimeout.unref()')) {
    throw new Error(
      'pi-server-handshake-unref: Server.prototype.accept no longer calls handshakeTimeout.unref(); revisit patches.json'
    );
  }
  target.prototype.accept = function accept(this: unknown, ...args: unknown[]) {
    return withUnrefTimers(() => original.apply(this, args));
  };
  target[applied] = true;
}

export function applyPatches(): void {
  patchServerAccept(Server as unknown as Patchable);
}

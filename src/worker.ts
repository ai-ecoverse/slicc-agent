import type { AgentHost } from './host.ts';
import type { PortEndpoint } from './wire.ts';

export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function serveConnections(scope: WorkerScope, host: Promise<AgentHost>): void {
  scope.addEventListener('message', ({ data }) => {
    const port = (data as { connect?: PortEndpoint } | null)?.connect;
    if (!port) return;
    host.then(
      (ready) => ready.connect(port),
      () => port.close?.()
    );
  });
}

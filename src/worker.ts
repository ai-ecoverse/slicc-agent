import type { AgentHost } from './host.ts';
import type { PortEndpoint } from './wire.ts';

export interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function serveConnections(scope: WorkerScope, host: Promise<AgentHost>): void {
  scope.addEventListener('message', ({ data }) => {
    const message = data as { connect?: PortEndpoint; readOnly?: boolean; pages?: boolean } | null;
    const port = message?.connect;
    if (!port) return;
    const pages = message?.pages === false ? { pages: false } : {};
    host.then(
      (ready) => ready.connect(port, { readOnly: message?.readOnly === true, ...pages }),
      () => port.close?.()
    );
  });
}

export interface KernelPorts {
  kernel: MessagePort;
  admin?: MessagePort;
}

export function kernelPorts(scope: WorkerScope): Promise<KernelPorts> {
  return new Promise((resolve) => {
    scope.addEventListener('message', ({ data }) => {
      const message = data as { kernel?: MessagePort; admin?: MessagePort } | null;
      const kernel = message?.kernel;
      if (!kernel) return;
      resolve(message.admin ? { kernel, admin: message.admin } : { kernel });
    });
  });
}

export function kernelPort(scope: WorkerScope): Promise<MessagePort> {
  return kernelPorts(scope).then((ports) => ports.kernel);
}

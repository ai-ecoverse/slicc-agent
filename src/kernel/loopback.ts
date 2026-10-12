export const FACADE_PORT = 9222;
export const KERNEL = 'kernel.localhost';
const OWN_KERNEL = /^([1-9][0-9]{0,4})\.kernel\.localhost$/;

export function ownKernelServer(host: string): boolean {
  const port = OWN_KERNEL.exec(host)?.[1];
  return port !== undefined && Number(port) <= 65535 && Number(port) !== FACADE_PORT;
}

export function kernelHost(host: string): boolean {
  return host === KERNEL || host.endsWith(`.${KERNEL}`);
}

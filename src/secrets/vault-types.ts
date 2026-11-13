export type ErrorCode =
  | 'EINVAL'
  | 'ENOENT'
  | 'EACCES'
  | 'EEXIST'
  | 'EAGAIN'
  | 'ETIMEDOUT'
  | 'ENOTCONN'
  | 'ENOTSUP'
  | 'EIO';

export interface McpServerEntry {
  server: string;
  url: string;
  names?: string[];
  tokenUrl?: string;
}

export interface OutgoingRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string | Uint8Array;
}

export interface AgentRecord {
  kind: 'model' | 'mcp';
  name: string;
  placeholder: string;
  state: 'ready' | 'expired' | 'refreshing';
  provider?: string;
  server?: string;
  expiresAt?: number;
  settings?: Record<string, string>;
}

export interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  scope?: string;
  resource?: string;
}

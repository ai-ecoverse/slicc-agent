import type {
  AgentRecord as VaultAgentRecord,
  ErrorCode as VaultErrorCode,
  McpServerEntry as VaultMcpServerEntry,
  OAuthConfig as VaultOAuthConfig,
  OutgoingRequest as VaultOutgoingRequest,
} from '@ai-ecoverse/slicc-vault';
import type {
  AgentRecord,
  ErrorCode,
  McpServerEntry,
  OAuthConfig,
  OutgoingRequest,
} from '../src/secrets/vault-types.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const errorCode: Equal<ErrorCode, VaultErrorCode>;
declare const mcpServerEntry: Equal<McpServerEntry, VaultMcpServerEntry>;
declare const outgoingRequest: Equal<OutgoingRequest, VaultOutgoingRequest>;
declare const agentRecord: Equal<AgentRecord, VaultAgentRecord>;
declare const oauthConfig: Equal<OAuthConfig, VaultOAuthConfig>;

true satisfies typeof errorCode;
true satisfies typeof mcpServerEntry;
true satisfies typeof outgoingRequest;
true satisfies typeof agentRecord;
true satisfies typeof oauthConfig;

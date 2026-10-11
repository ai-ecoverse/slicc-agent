export function mcpLabel(name: string): string | undefined {
  const found = /^mcp__([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)__(.+)$/.exec(name);
  return found ? `${found[1]} · ${found[2]}` : undefined;
}

export const MCP_ACCOUNT = 'mcp:';

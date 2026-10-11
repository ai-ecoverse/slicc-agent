export function mcpLabel(name: string): string | undefined {
  const parts = name.split('__');
  if (parts.length !== 3 || parts[0] !== 'mcp') return undefined;
  const [, server, tool] = parts as [string, string, string];
  if (!/^[A-Za-z0-9](?:.*[A-Za-z0-9])?$/.test(server) || !/^[A-Za-z0-9]/.test(tool))
    return undefined;
  return `${server} · ${tool}`;
}

export const MCP_ACCOUNT = 'mcp:';

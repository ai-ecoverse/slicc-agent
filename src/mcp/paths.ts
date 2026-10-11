export function configPath(home: string, dir = `${home}/.pi/agent`): string {
  return `${dir}/mcp.json`;
}

export function logPath(home: string, dir = `${home}/.pi/agent`): string {
  return `${dir}/mcp.log`;
}

export function shown(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

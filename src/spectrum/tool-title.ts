import { mcpLabel } from '../mcp/label.ts';
import { redactSecrets } from '../memory/format.ts';

type Json = Record<string, unknown>;

const TITLE_LENGTH = 60;

function leaf(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
}

function shown(text: string): string {
  const flat = redactSecrets(text).text.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
}

function file(verb: string, path: string): string {
  const name = leaf(path);
  return shown(name ? `${verb} ${name}` : verb);
}

export function toolTitle(name: string, args: Json | undefined): string {
  const labeled = mcpLabel(name);
  if (labeled) return labeled;
  const path = typeof args?.path === 'string' ? args.path : '';
  const command = typeof args?.command === 'string' ? args.command : '';
  if (name === 'bash') return 'Use the computer';
  if (name === 'read') return file('Read', path);
  if (name === 'write') return file('Write', path);
  if (name === 'edit') return file('Edit', path);
  if (name === 'codemode') return 'Run code';
  if (path) {
    const fileName = leaf(path);
    return shown(fileName ? `${name} ${fileName}` : name);
  }
  if (command) return shown(command) || name;
  return name;
}

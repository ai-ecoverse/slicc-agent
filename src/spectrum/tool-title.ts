import { intentOf } from '../intent/said.ts';
import { mcpLabel } from '../mcp/label.ts';
import { redactSecrets } from '../memory/format.ts';
import { listed } from '../ran/shown.ts';

type Json = Record<string, unknown>;

const TITLE_LENGTH = 60;

function leaf(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
}

export function shownTitle(text: string): string {
  const flat = redactSecrets(text).text.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
}

function file(verb: string, path: string): string {
  const name = leaf(path);
  return shownTitle(name ? `${verb} ${name}` : verb);
}

const PROGRAMS_SHOWN = 3;

function program(segment: string): string | undefined {
  const words = segment.trim().split(/\s+/);
  const word = words.find((each) => !/^\w+=/.test(each) && each !== 'sudo' && each !== 'env');
  const name = leaf(word ?? '');
  return /^[\w.+-]+$/.test(name) ? name : undefined;
}

export function commandTitle(command: string): string {
  const head = command.replace(/<<[\s\S]*/, '');
  const names = [
    ...new Set(
      head
        .split(/&&|\|\||[;|&\n()]/)
        .map(program)
        .filter((name) => name !== undefined)
    ),
  ];
  if (!names.length) return 'Running a command';
  const shown = names.slice(0, PROGRAMS_SHOWN);
  const more = names.length > PROGRAMS_SHOWN ? [...shown, 'more'] : shown;
  return `Running ${listed(more)}`;
}

export function toolTitle(name: string, args: Json | undefined, trusted = false): string {
  const said = trusted ? intentOf(name, args) : '';
  if (said) return shownTitle(said);
  const labeled = mcpLabel(name);
  if (labeled) return `Calling ${labeled}`;
  const path = typeof args?.path === 'string' ? args.path : '';
  const command = typeof args?.command === 'string' ? args.command : '';
  if (name === 'bash') return shownTitle(commandTitle(command));
  if (name === 'read') return file('Reading', path);
  if (name === 'write') return file('Writing', path);
  if (name === 'edit') return file('Editing', path);
  if (name === 'codemode') return 'Running code';
  if (path) {
    const fileName = leaf(path);
    return shownTitle(fileName ? `${name} ${fileName}` : name);
  }
  if (command) return shownTitle(command) || name;
  return name;
}

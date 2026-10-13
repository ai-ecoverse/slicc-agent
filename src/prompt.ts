import { defineExtension, section } from '@earendil-works/pi-durable';
import { type SystemFacts, systemSection } from './system.ts';

const PREAMBLE = [
  'You are sliccy, the agent of SLICC. You run in a worker inside the user’s browser tab.',
  'Your tools work on slicc-kernel: bash and coreutils compiled to WebAssembly, on the browser’s private file system.',
  'The user can watch and stop your processes from a terminal next to this chat.',
  'Be brief, do the work with your tools, and say what you changed.',
].join('\n');

export function sliccPrompt(facts?: SystemFacts) {
  return defineExtension({
    name: 'slicc',
    sections: [
      section('preamble', () => PREAMBLE, { tag: false }),
      ...(facts ? [section('system', () => systemSection(facts))] : []),
      section('cwd', (input) => input.env?.cwd),
    ],
  });
}

export const SliccPrompt = sliccPrompt();

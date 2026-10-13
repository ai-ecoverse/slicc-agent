import { defineExtension, hook, section, ToolTask } from '@earendil-works/pi-durable';
import { drivesBrowser } from './browser/guard.ts';
import { type BrowserProbe, type SystemFacts, systemSection } from './system.ts';

const PREAMBLE = [
  'You are sliccy, the agent of SLICC. You run in a worker inside the user’s browser tab.',
  'Your tools work on slicc-kernel: bash and coreutils compiled to WebAssembly, on the browser’s private file system.',
  'The user can watch and stop your processes from a terminal next to this chat.',
  'Be brief, do the work with your tools, and say what you changed.',
].join('\n');

export function sliccPrompt(facts?: SystemFacts, browser?: BrowserProbe) {
  return defineExtension({
    name: 'slicc',
    sections: [
      section('preamble', () => PREAMBLE, { tag: false }),
      ...(facts
        ? [
            section('system', async () =>
              systemSection(browser ? { ...facts, browser: await browser.connected() } : facts)
            ),
          ]
        : []),
      section('cwd', (input) => input.env?.cwd),
    ],
    hooks: browser
      ? [
          hook(ToolTask, {
            afterTool: (call, result) => {
              if (result.isError && call.name === 'bash' && drivesBrowser(call.arguments))
                browser.stale();
            },
          }),
        ]
      : [],
  });
}

export const SliccPrompt = sliccPrompt();

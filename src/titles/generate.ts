import type { Context } from '@earendil-works/chord';
import type { Message } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { answerText } from '../agent.ts';
import { extractSettings } from '../memory/extract.ts';
import { redactSecrets } from '../memory/format.ts';
import { scrubText } from '../secrets/scrub.ts';

export const TITLE_PROMPT =
  'Give this chat a title of three to six words that says what it is about, in the language the user writes in. Answer with the title only, without quotes.';

export const TRANSCRIPT_LENGTH = 4000;

export function titlesOn(text: string | undefined): boolean {
  try {
    return (JSON.parse(text ?? '{}') as { titles?: unknown }).titles !== false;
  } catch {
    return true;
  }
}

export function settingsText(
  env: Pick<ExecutionEnv, 'readTextFile'>,
  home: string,
  dir = `${home}/.pi/agent`
): (context: Context) => Promise<string | undefined> {
  return async (context) => {
    const read = await env.readTextFile(`${dir}/settings.json`, context);
    return read.ok ? read.value : undefined;
  };
}

function textOf(entry: EntryRecord): string {
  return answerText(entry.model?.[0]?.content).trim();
}

export function transcriptOf(entries: readonly EntryRecord[]): string {
  return entries
    .filter((entry) => entry.kind === 'pi.user' || entry.kind === 'pi.assistant')
    .map((entry) => `${entry.kind === 'pi.user' ? 'User' : 'Agent'}: ${textOf(entry)}`)
    .join('\n');
}

export async function scrubTranscript(entries: readonly EntryRecord[]): Promise<string> {
  const raw = transcriptOf(entries);
  const redacted = redactSecrets(raw).text;
  const scrubbed = await scrubText(redacted);
  return scrubbed.slice(0, TRANSCRIPT_LENGTH);
}

export function titler(
  models: Models,
  settings: (context: Context) => Promise<string | undefined>
) {
  return async (
    transcript: string,
    model: string,
    context: Context
  ): Promise<string | undefined> => {
    const text = await settings(context);
    if (!titlesOn(text)) return undefined;
    const chosen = extractSettings(text).model;
    const [provider, ...rest] = model.split('/');
    const ref = chosen ?? (provider && rest.length ? { provider, modelId: rest.join('/') } : null);
    const found = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
    if (!found || !transcript) return undefined;
    const message = await models.completeSimple(
      found,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `${TITLE_PROMPT}\n\n${transcript}` }],
            timestamp: Date.now(),
          } as Message,
        ],
      },
      { maxTokens: 40 }
    );
    if (message.stopReason === 'error') return undefined;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim();
  };
}

import type { Context } from '@earendil-works/chord';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { answerText } from '../agent.ts';
import { extractSettings } from '../memory/extract.ts';
import { redactSecrets } from '../memory/format.ts';
import { scrubText } from '../secrets/scrub.ts';

export const TITLE_PROMPT =
  'Give this chat a title of three to six words that says what it is about, in the language the user writes in. Answer with the title only, without quotes.';

export const LABEL_PROMPT =
  'Label this group of tool runs in three to eight words, as an imperative that says what they do, such as "Check the failing build logs". Answer with the label only, without quotes.';

export const TRANSCRIPT_LENGTH = 4000;

type Switch = 'titles' | 'toolLabels';

function settingOn(text: string | undefined, key: Switch): boolean {
  try {
    return (JSON.parse(text ?? '{}') as Record<string, unknown>)[key] !== false;
  } catch {
    return true;
  }
}

export function titlesOn(text: string | undefined): boolean {
  return settingOn(text, 'titles');
}

export function labelsOn(text: string | undefined): boolean {
  return settingOn(text, 'toolLabels');
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

export async function scrubbed(raw: string): Promise<string> {
  const redacted = redactSecrets(raw).text;
  return (await scrubText(redacted)).slice(0, TRANSCRIPT_LENGTH);
}

export function scrubTranscript(entries: readonly EntryRecord[]): Promise<string> {
  return scrubbed(transcriptOf(entries));
}

type Settings = (context: Context) => Promise<string | undefined>;

export type Asked = { text: string; answer: AssistantMessage };

function smallModel(models: Models, settings: Settings, key: Switch, prompt: string, max: number) {
  return async (
    transcript: string,
    model: string,
    context: Context,
    admit: () => boolean = () => true
  ): Promise<Asked | undefined> => {
    const text = await settings(context);
    if (!settingOn(text, key)) return undefined;
    const chosen = extractSettings(text).model;
    const [provider, ...rest] = model.split('/');
    const ref = chosen ?? (provider && rest.length ? { provider, modelId: rest.join('/') } : null);
    const found = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
    if (!found || !transcript || !admit()) return undefined;
    const message = await models.completeSimple(
      found,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `${prompt}\n\n${transcript}` }],
            timestamp: Date.now(),
          } as Message,
        ],
      },
      { maxTokens: max }
    );
    if (message.stopReason === 'error') return undefined;
    const said = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim();
    return { text: said, answer: message };
  };
}

export function titler(models: Models, settings: Settings) {
  const ask = smallModel(models, settings, 'titles', TITLE_PROMPT, 40);
  return async (transcript: string, model: string, context: Context) =>
    (await ask(transcript, model, context))?.text;
}

export function labeler(models: Models, settings: Settings) {
  return smallModel(models, settings, 'toolLabels', LABEL_PROMPT, 40);
}

export type Labeler = ReturnType<typeof labeler>;

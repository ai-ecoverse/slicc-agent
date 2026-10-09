import type { Context } from '@earendil-works/chord';
import type { Message } from '@earendil-works/pi-ai';
import type { Models } from '@earendil-works/pi-ai/models';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { extractSettings } from '../memory/extract.ts';

export const TITLE_PROMPT =
  'Give this chat a title of three to six words that says what it was about. Answer with the title only, without quotes.';

export function settingsText(
  env: Pick<ExecutionEnv, 'readTextFile'>,
  home: string
): (context: Context) => Promise<string | undefined> {
  return async (context) => {
    const read = await env.readTextFile(`${home}/.pi/agent/settings.json`, context);
    return read.ok ? read.value : undefined;
  };
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
    const chosen = extractSettings(await settings(context)).model;
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

import type { Context } from '@earendil-works/chord';
import type { Models } from '@earendil-works/pi-ai/models';
import { ADOBE } from '../adobe.ts';
import { lickId } from './lick.ts';
import type { LickEvent } from './licks.ts';

export const TRIAGE_MODEL = 'clef-flash';
export const TRIAGE_SKIP = 0.75;
export const TRIAGE_KIND = 'slicc.lick-triage';
export const TRIAGE_LIMIT = 4000;
const TRIAGE_TIMEOUT = 15_000;

export interface Verdict {
  decision: 'act' | 'ignore';
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  cost: number | null;
}

export type Triage = (event: LickEvent, context: Context) => Promise<Verdict | undefined>;

export function clip(text: string): string {
  return text.length > TRIAGE_LIMIT ? `${text.slice(0, TRIAGE_LIMIT)}…` : text;
}

function stateOf(event: LickEvent) {
  return {
    channel: event.channel,
    source: event.source,
    title: event.title,
    text: event.text,
    ...(event.body ? { body: clip(event.body) } : {}),
    ...(event.items?.length ? { items: event.items.slice(0, 50) } : {}),
  };
}

export function skips(verdict: Verdict | undefined): verdict is Verdict {
  return verdict?.decision === 'ignore' && (verdict.probabilities.ignore ?? 0) >= TRIAGE_SKIP;
}

export function lickTriage(models: Pick<Models, 'getModelOfType' | 'classify'>): Triage {
  return async (event) => {
    const model = models.getModelOfType('classifier', ADOBE, TRIAGE_MODEL);
    if (!model || !event.triage) return undefined;
    const result = await models.classify(
      model,
      {
        state: stateOf(event),
        questions: {
          triage: {
            type: 'choice',
            instructions: `The state is an event from a ${event.channel} source the user configured. The user wants the agent woken only for events that match this: ${event.triage}`,
            criteria: {
              act: 'the event matches what the user wants the agent to act on',
              ignore: 'the event does not match it, so the agent need not see it',
            },
          },
        },
      },
      { timeoutMs: TRIAGE_TIMEOUT, maxRetries: 1 }
    );
    const answer = result.answers.triage;
    if (result.stopReason !== 'stop' || answer?.type !== 'choice') return undefined;
    if (answer.choice !== 'act' && answer.choice !== 'ignore') return undefined;
    return {
      decision: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: `${ADOBE}/${TRIAGE_MODEL}`,
      cost: result.usage?.cost.total ?? null,
    };
  };
}

export function skipEntry(event: LickEvent, verdict: Verdict, now: number) {
  const id = lickId();
  return {
    type: 'write' as const,
    requestId: `lick-triage:${id}`,
    entry: {
      kind: TRIAGE_KIND,
      data: {
        lick: id,
        ...stateOf(event),
        count: event.count ?? 1,
        at: now,
        triage: event.triage ?? '',
        ...verdict,
      },
    },
  };
}

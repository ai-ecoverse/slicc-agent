import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import { type AgentsState, live } from '../agents.ts';
import { taggedTaints } from '../guests/tags.ts';
import type { LickEvent } from '../licks/licks.ts';
import { redactSecrets } from '../memory/format.ts';
import type { SudoApproval, SudoRun } from './record.ts';
import { agentTarget } from './runnable.ts';
import { shellWord } from './sudo.ts';

export const KEEP_HOURS = 24;
export const MIB = 1024 * 1024;

export type LickHost = {
  harness: Pick<Harness, 'commit' | 'snapshot'>;
  agents: { state(): Readonly<AgentsState> };
  now?: () => number;
};

const redacted = (text: string) => redactSecrets(text).text;

export const sized = (bytes: number): string =>
  bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${Math.round(bytes / 1024)} KiB`;

function typed(item: SudoApproval): string {
  return (item.replay?.argv ?? [])
    .map((word) => shellWord(String(word)))
    .join(' ')
    .trim();
}

function where(item: SudoApproval): string {
  const { command, target, cwd } = item.detail;
  return `${command} as ${target ?? 'root'}${cwd ? ` in ${cwd}` : ''}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function clock(at: number, now: number): string {
  const when = new Date(at);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (when.toDateString() === new Date(now).toDateString()) return time;
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function outcome(run: SudoRun): { text: string; sentence: string; ok: boolean } {
  if (run.state === 'failed')
    return { text: run.error ?? 'failed', sentence: `didn't finish: ${run.error}`, ok: false };
  const signal = run.signal ? ` (${run.signal})` : '';
  if (run.capped)
    return {
      text: `stopped: its output passed ${sized(run.capped)}`,
      sentence: `was stopped because its output passed ${sized(run.capped)}${signal}`,
      ok: false,
    };
  if (run.state === 'stopped')
    return {
      text: 'stopped by the owner',
      sentence: `was stopped by the owner${signal}`,
      ok: false,
    };
  if (run.status === undefined)
    return {
      text: 'status unknown',
      sentence: 'ended while the agent was away, so its exit status is unknown',
      ok: false,
    };
  if (run.signal)
    return {
      text: `killed by ${run.signal}`,
      sentence: `was killed by ${run.signal} (status ${run.status})`,
      ok: false,
    };
  return {
    text: `exit ${run.status}`,
    sentence: `exited with status ${run.status}`,
    ok: run.status === 0,
  };
}

function handedOn(state: Readonly<AgentsState>, agentId: string): string[] {
  const scoop = agentId.startsWith('scoop:') ? state.scoops[agentId] : undefined;
  if (!scoop || live(scoop) || scoop.frozen) return [];
  return [`The scoop that asked, ${scoop.name}, has ended, so this goes to its cone.`];
}

export type RunFacts = {
  id: string;
  agentId: string;
  typed: string;
  where: string;
  requestedAt: number;
  run: SudoRun;
  tags: readonly string[];
  started: string;
  ended: string;
};

export function itemFacts(item: SudoApproval): RunFacts {
  const run = item.run as SudoRun;
  const replay = item.replay;
  return {
    id: item.id,
    agentId: item.requester.agentId as string,
    typed: typed(item),
    where: where(item),
    requestedAt: item.createdAt,
    run,
    tags: [...(replay?.tag ? [replay.tag] : []), ...(replay?.tags ?? [])],
    started: ` Output: ${run.stdout} (.err)`,
    ended: ` Read it with your shell if you need it: ${run.stdout} and ${run.stderr} (kept for ${KEEP_HOURS} h).`,
  };
}

async function lickBase(host: LickHost, facts: RunFacts) {
  const taints = await taggedTaints(host.harness, facts.tags, BACKGROUND_CONTEXT);
  return {
    channel: 'sudo-run' as const,
    source: facts.id,
    target: agentTarget(host.agents.state(), facts.agentId),
    coalesce: false,
    ...(taints.length ? { taints } : {}),
  };
}

function clean(event: LickEvent): LickEvent {
  return {
    ...event,
    title: redacted(event.title),
    text: redacted(event.text),
    body: redacted(event.body as string),
  };
}

const factsOf = (from: SudoApproval | RunFacts): RunFacts =>
  'kind' in from ? itemFacts(from) : from;

export async function startLick(host: LickHost, from: SudoApproval | RunFacts): Promise<LickEvent> {
  const facts = factsOf(from);
  const { run } = facts;
  const now = host.now?.() ?? Date.now();
  const pid = run.pid !== undefined ? ` (pid ${run.pid})` : '';
  return clean({
    ...(await lickBase(host, facts)),
    eventId: `${facts.id}:start`,
    title: `sudo runs now: ${facts.typed}`,
    text: '[the owner ran your timed-out sudo request]',
    body: [
      `Your sudo request from ${clock(facts.requestedAt, now)} (${facts.where}) timed out.`,
      `The owner ran it at ${clock(run.at, now)} with Run now. It runs in the background${pid}, with no terminal and no input.`,
      `Its result follows as another sudo-run lick.${facts.started}`,
      ...handedOn(host.agents.state(), facts.agentId),
    ].join('\n'),
  });
}

export async function endLick(host: LickHost, from: SudoApproval | RunFacts): Promise<LickEvent> {
  const facts = factsOf(from);
  const { run } = facts;
  const ran = outcome(run);
  const took = run.endedAt !== undefined ? ` after ${duration(run.endedAt - run.at)}` : '';
  const left = run.survivors?.length
    ? [
        `Still running: pid ${run.survivors.join(', ')}. They left its process group; the owner can end them with Stop in Approvals.`,
      ]
    : [];
  return clean({
    ...(await lickBase(host, facts)),
    eventId: `${facts.id}:end`,
    title: `sudo run ended: ${facts.typed}`,
    text: `[your late sudo run ended: ${ran.text}]`,
    body: [
      `${facts.where} ${ran.sentence}${took}.`,
      ...left,
      `Its output isn't shown here.${facts.ended}`,
      ...handedOn(host.agents.state(), facts.agentId),
    ].join('\n'),
    ...(ran.ok && !left.length ? {} : { severity: 'warn' as const }),
  });
}

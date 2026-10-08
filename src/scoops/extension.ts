import type { Context } from '@earendil-works/chord';
import {
  AssistantEntry,
  type ConversationId,
  defineExtension,
  defineTask,
  type Extension,
  type PromptInput,
  section,
  type ToolRegistration,
  wrapTool,
} from '@earendil-works/pi-durable';
import { answerText } from '../agent.ts';
import { AgentsDoc, live, type ScoopRecord } from '../agents.ts';
import { HOME } from '../kernel/env.ts';
import { normalize, resolve } from '../kernel/paths.ts';
import type { LickEvent } from '../licks/licks.ts';
import type { Role } from '../roles/roles.ts';
import { FROM_KIND } from './from.ts';
import { type Feed, SCOOPS_ROOT, type ScoopsHost, ScoopWorkDoc, workspace } from './service.ts';

export const PREVIEW = 1000;
const ADVERTISED = 16;

type Lookup = () => Promise<ScoopsHost>;

export function scoopFacts(record: Pick<ScoopRecord, 'name' | 'folder' | 'role'>): string {
  return [
    `You are the scoop "${record.name}"${record.role ? ` (role: ${record.role})` : ''}, a helper agent working for a cone. Messages come from the cone or from the user at a terminal; your final answer goes back to whoever asked, so end every task with a complete answer.`,
    `Work in ${workspace(record.folder)}. Your read, write and edit tools only reach ${SCOOPS_ROOT}/${record.folder} and /tmp, and read ${HOME}.`,
    'Your bash is not confined: it sees the whole file system and every process. Stay in your folder anyway, and change nothing outside it unless the request says so.',
    'You may run `agent` synchronously for a bounded side task (calls nest at most three deep), but you cannot start asynchronous scoops (`agent --async`, `subagent spawn`).',
  ].join('\n');
}

function lines(text: string): number {
  return text ? text.split('\n').length : 0;
}

export type ReportResult = { text: string; failed: string | null; path: string | null };

export function reportLick(
  record: ScoopRecord,
  id: string,
  report: ReportResult,
  route: { target?: string | null; channel?: 'scoop-notify' | 'bash' } = {}
): LickEvent {
  const status = report.failed ? (report.failed === 'aborted' ? 'stopped' : 'failed') : 'completed';
  const label = `${record.name} (${record.role ?? 'scoop'})`;
  const preview = report.text.length > PREVIEW ? `${report.text.slice(0, PREVIEW)}…` : report.text;
  const where = report.path ? `Output: ${report.path} (${lines(report.text)} lines)` : null;
  const reason = report.failed && report.failed !== 'aborted' ? `Reason: ${report.failed}` : null;
  return {
    channel: route.channel ?? 'scoop-notify',
    source: id,
    title: label,
    text: `[scoop ${record.name} (${record.role ?? 'scoop'}) ${status}]`,
    body: [where, reason, preview].filter(Boolean).join('\n\n'),
    target: (route.target ?? `cone:${record.cone}`) as LickEvent['target'],
    ...(report.failed && report.failed !== 'aborted' ? { severity: 'warn' as const } : {}),
  };
}

export function waitTask(lookup: Lookup) {
  type WaitInput = { scoops: string[]; cone: string; deadline: number };

  return defineTask<WaitInput, { phase: 'start' } | { phase: 'watch' }, null>({
    name: 'slicc.scoop-wait',
    version: 1,
    initial: () => ({ phase: 'start' }),
    phases: {
      async start(task, runtime, context) {
        await runtime.commit(async (tx) => {
          (await tx.doc(ScoopWorkDoc)).waits[String(task.id)] = {
            scoops: task.input.scoops,
            done: {},
            cone: task.input.cone,
          };
          return { status: 'running', checkpoint: { phase: 'watch' } };
        }, context);
      },
      async watch(task, runtime, context) {
        const { agents, licks } = await lookup();
        const key = String(task.id);
        for (;;) {
          const work = await runtime.snapshot(ScoopWorkDoc, context);
          const state = work?.waits[key];
          if (!state) break;
          const feeding = new Set(Object.values(work?.feeds ?? {}).map((feed) => feed.scoop));
          const open = state.scoops.filter((id) => !(id in state.done) && feeding.has(id));
          const expired = runtime.now() >= task.input.deadline;
          if (open.length && !expired) {
            await runtime.sleep(Math.min(runtime.now() + 300, task.input.deadline), context);
            continue;
          }
          const names = (id: string) => agents.state().scoops[id]?.name ?? id;
          const body = state.scoops.map((id) =>
            open.includes(id)
              ? `## ${names(id)}\n(still working when the wait timed out)`
              : `## ${names(id)}\n${state.done[id] ?? '(nothing was running)'}`
          );
          await licks.deliver(
            {
              channel: 'scoop-wait',
              source: key,
              title: `Waited for ${state.scoops.map(names).join(', ')}`,
              text: open.length
                ? `${state.scoops.length - open.length} of ${state.scoops.length} done; timed out waiting for ${open.map(names).join(', ')}`
                : `All ${state.scoops.length} done`,
              body: body.join('\n\n'),
              target: `cone:${state.cone}`,
              coalesce: false,
              eventId: `wait:${key}`,
            },
            context
          );
          break;
        }
        await runtime.commit(async (tx) => {
          delete (await tx.doc(ScoopWorkDoc)).waits[key];
          return { status: 'terminal', outcome: { status: 'completed', result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        delete (await tx.doc(ScoopWorkDoc)).waits[String(task.id)];
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context),
  });
}

export function scoopTasks(lookup: Lookup) {
  const anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'slicc.scoop-anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: {
      done: (_task, runtime, context) =>
        runtime.commit(
          () => ({ status: 'terminal', outcome: { status: 'completed', result: null } }),
          context
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  });

  type ReporterInput = {
    scoop: string;
    prompt: string;
    followUp?: boolean;
    request?: string;
  };
  type ReporterState =
    | { phase: 'deliver'; noted?: boolean }
    | { phase: 'report'; text: string; failed: string | null };

  const reporter = defineTask<ReporterInput, ReporterState, ReportResult>({
    name: 'slicc.scoop-reporter',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      async deliver(task, runtime, context) {
        const { agents } = await lookup();
        const record = agents.state().scoops[task.input.scoop];
        const handle =
          record && live(record)
            ? await runtime.conversation(record.conversation as ConversationId, context)
            : undefined;
        if (!handle) {
          await runtime.commit(async (tx) => {
            delete (await tx.doc(ScoopWorkDoc)).feeds[String(task.id)];
            return {
              status: 'terminal',
              outcome: {
                status: 'completed',
                result: { text: '', failed: 'the scoop is gone', path: null },
              },
            };
          }, context);
          return;
        }
        const requestId = task.input.request ? `subagent:${task.input.request}` : `feed:${task.id}`;
        const from = (await runtime.snapshot(ScoopWorkDoc, context))?.feeds[String(task.id)]?.from;
        if (from && !task.state.checkpoint.noted)
          await runtime.commit(async (tx) => {
            await tx.appendEntry(record?.conversation as ConversationId, {
              kind: FROM_KIND,
              data: { from, text: task.input.prompt },
            });
            return { status: 'running', checkpoint: { phase: 'deliver', noted: true } };
          }, context);
        const submission = await handle.submit(
          {
            type: 'input',
            content: task.input.prompt,
            whenBusy: task.input.followUp ? 'followUp' : 'steer',
            requestId,
          },
          context
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          if (settled.status !== 'done' || settled.type !== 'input')
            return {
              status: 'running',
              checkpoint: {
                phase: 'report',
                text: '',
                failed: String(settled.reason),
              },
            };
          const answer = await tx.entry(AssistantEntry, settled.answer);
          return {
            status: 'running',
            checkpoint: {
              phase: 'report',
              text: answerText(answer?.model?.[0]?.content),
              failed: null,
            },
          };
        }, context);
      },
      async report(task, runtime, context) {
        const { agents, licks } = await lookup();
        const id = task.input.scoop;
        const record = agents.state().scoops[id];
        const { text, failed } = task.state.checkpoint;
        const path =
          record && text ? `${SCOOPS_ROOT}/${record.folder}/reports/${task.id}.md` : null;
        if (path)
          await (await runtime.env(context))?.writeFile(
            path,
            text.endsWith('\n') ? text : `${text}\n`,
            context
          );
        const work = await runtime.snapshot(ScoopWorkDoc, context);
        const entry = work?.feeds[String(task.id)] as Feed;
        const waiting = (wait: { scoops: string[]; done: Record<string, string> }) =>
          wait.scoops.includes(id) && !(id in wait.done);
        const folded = Object.values(work?.waits ?? {}).some(waiting);
        const route = { target: entry.target, channel: entry.channel };
        if (!folded && record && entry.report && failed !== 'aborted')
          await licks.deliver(
            {
              ...reportLick(record, id, { text, failed, path }, route),
              eventId: `report:${task.id}`,
            },
            context
          );
        await runtime.commit(async (tx) => {
          const work = await tx.doc(ScoopWorkDoc);
          for (const wait of Object.values(work.waits))
            if (waiting(wait))
              wait.done[id] = failed
                ? `stopped: ${failed}`
                : `${path ? `Output: ${path}\n` : ''}${text || '(no text)'}`;
          delete work.feeds[String(task.id)];
          return {
            status: 'terminal',
            outcome: { status: 'completed', result: { text, failed, path } },
          };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        delete (await tx.doc(ScoopWorkDoc)).feeds[String(task.id)];
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context),
  });

  return { anchor, reporter, wait: waitTask(lookup) };
}

async function whose(input: PromptInput, context: Context) {
  const state = await input.read.snapshot(AgentsDoc, context);
  const scoop = Object.values(state?.scoops ?? {}).find(
    (record) => record.conversation === input.conversationId
  );
  const cone = Object.values(state?.cones ?? {}).some(
    (record) => record.conversation === input.conversationId
  );
  return { scoop, cone };
}

export function rolesSection(roles: readonly Role[]): string {
  const shown = roles.slice(0, ADVERTISED);
  return [
    'Roles for `subagent spawn --agent <role>`:',
    ...shown.map(
      (role) =>
        `- ${role.name}${role.aliases.length ? ` (also ${role.aliases.join(', ')})` : ''}: ${role.description}`
    ),
    ...(roles.length > shown.length
      ? [`… and ${roles.length - shown.length} more; \`subagent list --agents\` shows them all.`]
      : []),
  ].join('\n');
}

export interface ScoopSections {
  roles(): readonly Role[];
  skill(): string;
}

export function scoopsExtension(
  tasks: ReturnType<typeof scoopTasks>,
  sections: ScoopSections
): Extension {
  return defineExtension({
    name: 'slicc-scoops',
    tasks: [tasks.anchor, tasks.reporter, tasks.wait],
    sections: [
      section('scoop', async (input, context) => {
        const { scoop } = await whose(input, context);
        return scoop ? scoopFacts(scoop) : undefined;
      }),
      section('subagent', async (input, context) => {
        const { cone } = await whose(input, context);
        if (!cone) return undefined;
        return [sections.skill(), rolesSection(sections.roles())].filter(Boolean).join('\n\n');
      }),
    ],
  });
}

const WRITES = new Set(['write', 'edit']);

export function allowed(
  record: Pick<ScoopRecord, 'folder'> & { roots?: ScoopRecord['roots'] },
  coneCwd: string,
  path: string,
  writing: boolean
): boolean {
  const own = `${SCOOPS_ROOT}/${record.folder}`;
  const write = [own, '/tmp', ...(record.roots?.write ?? [])];
  const roots = writing ? write : [...write, coneCwd, ...(record.roots?.read ?? [])];
  return roots.some((root) => path === root || path.startsWith(`${root === '/' ? '' : root}/`));
}

function refusal(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

export function guardExtension(lookup: Lookup, tools: readonly ToolRegistration[]): Extension {
  const wraps = tools
    .filter((tool) => tool.name === 'read' || WRITES.has(tool.name))
    .map((tool) =>
      wrapTool(tool, (inner) => ({
        ...inner,
        async execute(args, api, context) {
          const { agents } = await lookup();
          const record = Object.values(agents.state().scoops).find(
            (scoop) => scoop.conversation === api.conversationId
          );
          if (!record) return inner.execute(args, api, context);
          const path = String((args as { path: unknown }).path);
          let target = normalize(resolve(workspace(record.folder), path));
          const canonical = await api.env?.canonicalPath(target, context);
          if (canonical?.ok) target = canonical.value;
          if (allowed(record, HOME, target, WRITES.has(inner.name)))
            return inner.execute(args, api, context);
          return refusal(
            `${target} is outside this scoop's folders. ${inner.name} reaches ${SCOOPS_ROOT}/${record.folder} and /tmp${WRITES.has(inner.name) ? '' : `, and reads ${HOME}`}.`
          );
        },
      }))
    );
  return defineExtension({ name: 'slicc-scoop-guard', wraps });
}

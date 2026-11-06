import type { Context } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { AgentsState } from '../agents.ts';
import { CONE_PREFIX } from '../kernel/accounts.ts';
import { ROOT_USER } from '../layout.ts';

export const MESSAGE_CHANNEL = 'cone-message';
export const SELF = 'cone';
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_WAITING = 3;
const FIRST_GID = 1000;
const LAST_GID = 60000;
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;

export function printable(text: string): string {
  return text.replace(CONTROL, '');
}

export function hasControl(text: string): boolean {
  return printable(text) !== text;
}

export type Found = { id: string; name: string };
export type Lookup = Found | { error: string } | undefined;

export function coneLabel(state: Readonly<AgentsState>, id: string): string {
  return `${printable(id)} ${JSON.stringify(printable(state.cones[id]?.name ?? id))}`;
}

export function addressOf(id: string, self: string): string {
  return id === SELF && self !== SELF ? `${CONE_PREFIX}${id}` : id;
}

function named(state: Readonly<AgentsState>, name: string): string[] {
  if (state.cones[name]) return [name];
  const cones = Object.entries(state.cones);
  const exact = cones.filter(([, record]) => record.name === name);
  const lower = name.toLowerCase();
  const found = exact.length
    ? exact
    : cones.filter(([, record]) => record.name.toLowerCase() === lower);
  return found.map(([id]) => id);
}

function frozen(state: Readonly<AgentsState>, name: string, id: string | undefined) {
  return Object.values(state.frozen ?? {}).find((record) =>
    id === undefined ? record.cone === name || record.name === name : record.cone === id
  );
}

export function findCone(state: Readonly<AgentsState>, name: string, self: string): Lookup {
  if (name === SELF) return { id: self, name: state.cones[self]?.name ?? self };
  const id = name.startsWith(CONE_PREFIX) ? name.slice(CONE_PREFIX.length) : undefined;
  const ids = id === undefined ? named(state, name) : state.cones[id] ? [id] : [];
  if (ids.length === 1) {
    const one = ids[0] as string;
    return { id: one, name: state.cones[one]?.name ?? one };
  }
  if (ids.length > 1)
    return {
      error: `${printable(name)} names ${ids.length} cones: ${ids.map((each) => coneLabel(state, each)).join(', ')}; send to one by its user name, such as agent send ${addressOf(ids[0] as string, self)} …`,
    };
  const cold = frozen(state, name, id);
  if (cold)
    return {
      error: `the cone ${cold.cone} ${JSON.stringify(printable(cold.name))} is frozen; thaw it in the Freezer before you message it`,
    };
  return undefined;
}

export type Tables = {
  uids: Map<string, number>;
  names: Map<number, string>;
  primary: Map<string, number>;
  groups: { name: string; gid: number; members: string[] }[];
};

const fields = (text: string) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(':'));

export function tablesOf(passwd: string, group: string): Tables {
  const tables: Tables = { uids: new Map(), names: new Map(), primary: new Map(), groups: [] };
  for (const [name, , uid, gid] of fields(passwd)) {
    const user = Number(uid);
    if (!name || !Number.isInteger(user)) continue;
    tables.uids.set(name, user);
    if (!tables.names.has(user)) tables.names.set(user, name);
    tables.primary.set(name, Number(gid));
  }
  for (const [name, , gid, members] of fields(group))
    if (name && Number.isInteger(Number(gid)))
      tables.groups.push({ name, gid: Number(gid), members: (members ?? '').split(',') });
  return tables;
}

export async function readTables(
  env: Pick<ExecutionEnv, 'readTextFile'>,
  context: Context
): Promise<Tables> {
  const text = async (path: string) => {
    const read = await env.readTextFile(path, context);
    return read.ok ? read.value : '';
  };
  return tablesOf(await text('/etc/passwd'), await text('/etc/group'));
}

export function sharedGroups(tables: Tables, a: string, b: string): string[] {
  const own = (user: string, group: Tables['groups'][number]) =>
    tables.primary.get(user) === group.gid || group.members.includes(user);
  return tables.groups
    .filter((group) => group.gid >= FIRST_GID && group.gid <= LAST_GID)
    .filter((group) => own(a, group) && own(b, group))
    .map((group) => group.name);
}

export type Reach = { kind: 'root' | 'self' | 'group' | 'sudo'; groups: string[] };

export function reachOf(tables: Tables, sender: string, target: string): Reach {
  if (sender === ROOT_USER) return { kind: 'root', groups: [] };
  if (sender === target) return { kind: 'self', groups: [] };
  const groups = sharedGroups(tables, sender, target);
  return { kind: groups.length ? 'group' : 'sudo', groups };
}

export function refusal(state: Readonly<AgentsState>, sender: string, target: string): string {
  return `the cone ${coneLabel(state, target)} shares no group with you (${printable(sender)}); cones in other groups need sudo -u ${target} agent send ${target} …, which the sudoers policy and its approvals allow or refuse`;
}

export function reachText(reach: Reach, target: string): string {
  if (reach.kind === 'root') return 'root may message any cone';
  if (reach.kind === 'self') return 'you';
  if (reach.kind === 'group') return `shares ${reach.groups.join(', ')}`;
  return `sudo -u ${target} agent send ${target} …`;
}

export type Hop = { user: string; agent: string | null; sudo: boolean };

export type Sender = {
  user: string;
  agent: string | null;
  hop?: Hop;
};

export function hopText(hop: Hop, user: string): string {
  return ` through ${hop.sudo ? 'sudo' : `a process of ${hop.user}`} as ${user}`;
}

function agentLabel(state: Readonly<AgentsState>, agent: string): string {
  if (agent.startsWith(CONE_PREFIX)) {
    const id = agent.slice(CONE_PREFIX.length);
    return `${agent} ${JSON.stringify(printable(state.cones[id]?.name ?? id))}`;
  }
  const record = state.scoops[agent];
  return record
    ? `${agent} ${JSON.stringify(printable(record.name))} of ${CONE_PREFIX}${record.cone}`
    : agent;
}

function speaker(state: Readonly<AgentsState>, agent: string | null, user: string): string {
  return agent ? `${agentLabel(state, agent)} (user ${user})` : `user ${user}`;
}

export type Described = { source: string; title: string; text: string };

export function describe(state: Readonly<AgentsState>, sender: Sender): Described {
  const by = sender.hop ?? sender;
  const agent = by.agent;
  const via = sender.hop ? hopText(sender.hop, sender.user) : '';
  const id = agent?.startsWith(CONE_PREFIX) ? agent.slice(CONE_PREFIX.length) : undefined;
  const name = id
    ? (state.cones[id]?.name ?? id)
    : agent
      ? (state.scoops[agent]?.name ?? agent)
      : by.user;
  return {
    source: agent ?? `user:${by.user}`,
    title: `Message from ${printable(name)}`,
    text: `[slicc message from ${speaker(state, agent, by.user)}${via}]`,
  };
}

export function tooLong(text: string): string | undefined {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= MAX_MESSAGE_BYTES) return undefined;
  return `the message is ${bytes} bytes, and a cone message is at most ${MAX_MESSAGE_BYTES}; send a shorter one, or several`;
}

export function crowded(state: Readonly<AgentsState>, target: string, waiting: number) {
  if (waiting < MAX_WAITING) return undefined;
  return `the cone ${coneLabel(state, target)} hasn't taken in your last ${waiting} messages yet; wait until it has, then send again`;
}

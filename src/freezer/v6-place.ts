import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { coneSpec } from '../kernel/accounts.ts';
import { ROOT_HOME } from '../layout.ts';
import type { ImportDeps } from './v6.ts';
import { type Opened, type Parsed, type Unit, type Where, whereOf } from './v6.ts';
import { ownTree, type Writer } from './v6-write.ts';
import { ImportError } from './zip.ts';

export const V6_ROOT = `${ROOT_HOME}/v6`;

export type Run = {
  deps: ImportDeps;
  opened: Opened;
  parsed: Parsed;
  writer: Writer;
  stage: string;
  date: string;
  show: (phase: 'writing', done: number, total: number) => void;
  fresh: Map<string, boolean>;
  ready: Set<Unit>;
};

async function staged(run: Run, zip: string): Promise<Uint8Array> {
  const read = await run.writer.env.readBinaryFile(`${run.stage}/${zip}`, run.writer.context);
  if (!read.ok) throw new ImportError(`the staged copy of ${zip} is gone`);
  return read.value;
}

async function prepare(run: Run, unit: Unit): Promise<void> {
  if (run.ready.has(unit)) return;
  run.ready.add(unit);
  const { users, layout, env } = run.deps;
  if (unit.fresh)
    run.writer.later(async () => {
      await users?.remove(unit.cone).catch(() => false);
      await env.remove(unit.home, { recursive: true, force: true }, BACKGROUND_CONTEXT);
    });
  if (layout.users && users) await users.add(coneSpec(unit.cone));
}

async function envOf(run: Run, unit: Unit | null): Promise<ExecutionEnv | undefined> {
  if (!unit || unit.fresh || !run.deps.layout.users) return undefined;
  const env = await run.deps.envOf?.(unit.cone);
  if (!env) throw new ImportError(`there is no kernel user ${unit.cone} to write its files as`);
  return env;
}

async function putIn(run: Run, unit: Unit | null, root: string, rest: string, zip: string) {
  if (unit) await prepare(run, unit);
  const env = await envOf(run, unit);
  let fresh = run.fresh.get(root);
  if (fresh === undefined) {
    fresh = unit?.fresh || (await run.writer.tree(root, env));
    run.fresh.set(root, fresh);
  }
  if (unit?.fresh) unit.roots.add(root);
  const path = `${root}/${rest}`;
  await run.writer.put(path, await staged(run, zip), fresh, env);
}

const clean = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';

type Maps = { byFolder: Map<string, Unit>; owners: Map<string, Unit> };

function targets(run: Run, maps: Maps, where: Where, zip: string): [Unit, string, string][] {
  if (where.kind === 'cone' || where.kind === 'scoop') {
    const unit = (where.kind === 'cone' ? maps.byFolder : maps.owners).get(where.folder) as Unit;
    const root =
      where.kind === 'cone'
        ? `${unit.home}/workspace${unit.suffix}`
        : `${unit.home}/scoops${unit.suffix}/${where.folder}`;
    return [[unit, root, where.rest]];
  }
  if (where.kind !== 'attachment') return [];
  return run.parsed.units.flatMap((unit) =>
    (unit.doc?.attachments ?? [])
      .filter((item) => item.present && item.path === zip)
      .map((item): [Unit, string, string] => {
        const rest = `${item.sha256.slice(0, 12)}-${clean(item.originalName)}`;
        unit.files.set(item.id, `${unit.home}/v6-attachments/${rest}`);
        return [unit, `${unit.home}/v6-attachments`, rest];
      })
  );
}

export async function place(run: Run): Promise<void> {
  const { manifest } = run.opened;
  const units = run.parsed.units;
  const byFolder = new Map(
    units.filter((unit) => unit.six).map((unit) => [unit.six as string, unit])
  );
  const owners = new Map(
    units.flatMap((unit) =>
      unit.scoops.filter((scoop) => scoop.six).map((scoop) => [scoop.six as string, unit])
    )
  );
  const maps: Maps = { byFolder, owners };
  const later: [string, string][] = [];
  for (const [at, file] of manifest.files.entries()) {
    const where = whereOf(manifest, file.path);
    if (where.kind === 'home-user') later.push([file.path, where.rest]);
    for (const [unit, root, rest] of targets(run, maps, where, file.path))
      await putIn(run, unit, root, rest, file.path);
    run.show('writing', at + 1, manifest.files.length);
  }
  for (const [zip, rest] of later) await putIn(run, null, `${V6_ROOT}/home-user`, rest, zip);
  if (run.deps.layout.users)
    for (const unit of units) await ownTree(run.writer, unit.cone, unit.home, unit.roots);
}

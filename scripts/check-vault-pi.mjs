import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './main.mjs';

const VAULT = '@ai-ecoverse/slicc-vault';
const PI_AI = '@earendil-works/pi-ai';

const minor = (version) =>
  /^(\d+)\.(\d+)\./
    .exec(version ?? '')
    ?.slice(1, 3)
    .join('.');

export function check(vault, piAi) {
  if (typeof vault.piAi !== 'string' || !minor(vault.piAi))
    return [
      `${VAULT} ${vault.version} declares no "piAi": its built-in model endpoints can't be checked against ${PI_AI} ${piAi.version}; update it to 1.12.2 or later`,
    ];
  if (minor(vault.piAi) !== minor(piAi.version))
    return [
      `${VAULT} ${vault.version} has the model endpoints of ${PI_AI} ${vault.piAi}, and the agent runs ${piAi.version}: bump both to the same minor (the pi-ai-lockstep PRs)`,
    ];
  return [];
}

const read = (root, name) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));

export const run = (root) => {
  const vault = read(root, VAULT);
  const piAi = read(root, PI_AI);
  return { vault, piAi, problems: check(vault, piAi) };
};

if (isMain(import.meta.url)) {
  const { vault, piAi, problems } = run(process.cwd());
  for (const problem of problems) console.error(`check-vault-pi: ${problem}`);
  if (problems.length) {
    console.log(`check-vault-pi: FAIL ${problems.length} problem`);
    process.exit(1);
  }
  console.log(
    `check-vault-pi: PASS ${VAULT} ${vault.version} has the endpoints of ${PI_AI} ${vault.piAi}, the agent runs ${piAi.version}`
  );
}

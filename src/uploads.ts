import type { Context } from '@earendil-works/chord';
import type { Conversation, ModelRef } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Saver } from './attachments.ts';

export interface Uploads {
  env(
    target: { conversationId: number; cwd?: string },
    context: Context
  ): ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  sees(model: ModelRef | undefined): boolean;
}

export const UPLOADS = 'uploads';

function cleaned(name: string): { stem: string; ext: string } {
  const clean = name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '') || 'attachment';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? { stem: clean.slice(0, dot), ext: clean.slice(dot) } : { stem: clean, ext: '' };
}

function must(result: { ok: boolean; error?: { message: string } }, name: string): void {
  if (!result.ok) throw new Error(`Couldn't save ${name}: ${result.error?.message}`);
}

export async function upload(
  env: ExecutionEnv,
  name: string,
  bytes: Uint8Array,
  context: Context
): Promise<string> {
  const dir = `${env.cwd.replace(/\/+$/, '')}/${UPLOADS}`;
  must(await env.createDir(dir, { recursive: true }, context), name);
  const { stem, ext } = cleaned(name);
  for (let n = 0; n < 100; n++) {
    const path = `${dir}/${n ? `${stem}-${n}${ext}` : `${stem}${ext}`}`;
    if ((await env.fileInfo(path, context)).ok) continue;
    must(await env.writeFile(path, bytes, context), name);
    return path;
  }
  throw new Error(`Couldn't find a free name for ${name} in ${dir}.`);
}

export async function saverFor(
  conversation: Conversation,
  uploads: Uploads | undefined,
  context: Context
): Promise<Saver> {
  if (!uploads) return { sees: true };
  const agent = await conversation.agent(context);
  return {
    sees: uploads.sees(agent.model),
    async save(name, bytes) {
      const target = {
        conversationId: conversation.id,
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
      };
      const env = await uploads.env(target, context);
      if (!env) throw new Error(`This agent has no folder to save ${name} in.`);
      return upload(env, name, bytes, context);
    },
  };
}

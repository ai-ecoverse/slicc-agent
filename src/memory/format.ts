export type MemoryTag = 'user' | 'feedback' | 'project';

export interface MemoryEntry {
  id: string;
  scope: string;
  section: string;
  title: string;
  body: string;
  tag: MemoryTag | null;
  updatedAt: number;
  source: 'entry' | 'notes';
}

export interface MemoryScope {
  id: string;
  label: string;
  group?: 'cones' | 'roles';
}

export type Entry = { title: string; tag: MemoryTag | null; body: string };
export type Section = { name: string; intro: string; entries: Entry[] };
export type MemoryDoc = { head: string; sections: Section[] };

export const MEMORY_FILE = 'MEMORY.md';
export const NOTES = 'Notes';
export const MAX_LINES = 200;
export const MAX_BYTES = 16 * 1024;
const TAGS = new Set<string>(['user', 'feedback', 'project']);

export function slugOf(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

function trimBlock(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd();
}

type Raw = { name: string; intro: string[]; entries: { title: string; lines: string[] }[] };

export function parseMemory(text: string): MemoryDoc {
  const doc: MemoryDoc = { head: '', sections: [] };
  const head: string[] = [];
  const sections: Raw[] = [];
  let section: Raw | null = null;
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h2 = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    const h3 = fenced ? null : /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      section = { name: h2[1] as string, intro: [], entries: [] };
      sections.push(section);
    } else if (h3) {
      if (!section) {
        section = { name: NOTES, intro: [], entries: [] };
        sections.push(section);
      }
      section.entries.push({ title: h3[1] as string, lines: [] });
    } else if (!section) head.push(line);
    else {
      const entry = section.entries.at(-1);
      (entry ? entry.lines : section.intro).push(line);
    }
  }
  doc.head = trimBlock(head);
  for (const found of sections) {
    doc.sections.push({
      name: found.name,
      intro: trimBlock(found.intro),
      entries: found.entries.map(({ title, lines }) => {
        const first = lines.findIndex((line) => line.trim() !== '');
        const tagged = first < 0 ? null : /^tag:\s*(\w+)\s*$/i.exec(lines[first] as string);
        const tag =
          tagged && TAGS.has((tagged[1] as string).toLowerCase())
            ? ((tagged[1] as string).toLowerCase() as MemoryTag)
            : null;
        return { title, tag, body: trimBlock(tag ? lines.slice(first + 1) : lines) };
      }),
    });
  }
  return doc;
}

export function serializeMemory(doc: MemoryDoc): string {
  const parts: string[] = [];
  if (doc.head) parts.push(doc.head);
  for (const section of doc.sections) {
    parts.push(`## ${section.name}`);
    if (section.intro) parts.push(section.intro);
    for (const entry of section.entries) {
      const lines = [`### ${entry.title}`];
      if (entry.tag) lines.push(`tag: ${entry.tag}`);
      parts.push(lines.join('\n'));
      if (entry.body) parts.push(entry.body);
    }
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

function headNotes(head: string): string {
  return head
    .split('\n')
    .filter((line) => !/^#\s/.test(line))
    .join('\n')
    .trim();
}

type Target =
  | { kind: 'head'; section: null; entry: null }
  | { kind: 'intro'; section: Section; entry: null }
  | { kind: 'entry'; section: Section; entry: Entry };

function walk(doc: MemoryDoc): Target[] {
  const out: Target[] = [];
  if (headNotes(doc.head)) out.push({ kind: 'head', section: null, entry: null });
  for (const section of doc.sections) {
    if (section.intro) out.push({ kind: 'intro', section, entry: null });
    for (const entry of section.entries) out.push({ kind: 'entry', section, entry });
  }
  return out;
}

function identify(targets: Target[], scope: string): string[] {
  const used = new Set<string>();
  return targets.map((target) => {
    const parts =
      target.kind === 'head'
        ? [NOTES]
        : target.kind === 'intro'
          ? [target.section.name]
          : [target.section.name, target.entry.title];
    const base = [scope, ...parts.map(slugOf)].join('/');
    let candidate = base;
    for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
    used.add(candidate);
    return candidate;
  });
}

export function memoryEntries(doc: MemoryDoc, scope: string, updatedAt: number): MemoryEntry[] {
  const targets = walk(doc);
  const ids = identify(targets, scope);
  return targets.map((target, index) => {
    const id = ids[index] as string;
    if (target.kind === 'head')
      return {
        id,
        scope,
        section: NOTES,
        title: NOTES,
        body: headNotes(doc.head),
        tag: null,
        updatedAt,
        source: 'notes',
      };
    if (target.kind === 'intro')
      return {
        id,
        scope,
        section: target.section.name,
        title: target.section.name,
        body: target.section.intro,
        tag: null,
        updatedAt,
        source: 'notes',
      };
    return {
      id,
      scope,
      section: target.section.name,
      title: target.entry.title,
      body: target.entry.body,
      tag: target.entry.tag,
      updatedAt,
      source: 'entry',
    };
  });
}

export type Change =
  | {
      kind: 'save';
      id?: string;
      section: string;
      title: string;
      body: string;
      tag: MemoryTag | null;
    }
  | { kind: 'remove'; id?: string; section?: string; title?: string };

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function demote(body: string): string {
  let fenced = false;
  return body
    .trim()
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/^(\s{0,3})#{2,3}(?=\s)/, '$1####');
    })
    .join('\n');
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function applyChange(
  doc: MemoryDoc,
  scope: string,
  change: Change
): { doc: MemoryDoc; found: boolean } {
  const next: MemoryDoc = {
    head: doc.head,
    sections: doc.sections.map((section) => ({ ...section, entries: [...section.entries] })),
  };
  const targets = walk(next);
  const ids = identify(targets, scope);
  const byId = change.id ? targets[ids.indexOf(change.id)] : undefined;
  const byTitle =
    change.section !== undefined && change.title !== undefined
      ? targets.find(
          (target) =>
            target.kind === 'entry' &&
            same(target.section.name, change.section as string) &&
            same(target.entry.title, change.title as string)
        )
      : undefined;
  const target = byId ?? byTitle;
  const drop = () => {
    if (target?.kind === 'head')
      next.head = next.head
        .split('\n')
        .filter((line) => /^#\s/.test(line))
        .join('\n');
    else if (target?.kind === 'intro') target.section.intro = '';
    else if (target?.kind === 'entry')
      target.section.entries.splice(target.section.entries.indexOf(target.entry), 1);
  };
  const tidy = () => {
    next.sections = next.sections.filter((section) => section.intro || section.entries.length);
    return { doc: next, found: target !== undefined };
  };
  if (change.kind === 'remove') {
    drop();
    return tidy();
  }
  const name = oneLine(change.section);
  const entry: Entry = { title: oneLine(change.title), tag: change.tag, body: demote(change.body) };
  if (target?.kind === 'entry' && same(target.section.name, name)) {
    target.section.entries[target.section.entries.indexOf(target.entry)] = entry;
    return tidy();
  }
  drop();
  let section = next.sections.find((item) => same(item.name, name));
  if (!section) {
    section = { name, intro: '', entries: [] };
    next.sections.push(section);
  }
  const clash = section.entries.findIndex((item) => same(item.title, entry.title));
  if (clash >= 0) section.entries[clash] = entry;
  else section.entries.push(entry);
  return tidy();
}

export function excerpt(text: string): { text: string; capped: boolean } {
  const lines = text.split('\n');
  let out = lines.slice(0, MAX_LINES).join('\n');
  let capped = lines.length > MAX_LINES;
  const bytes = new TextEncoder().encode(out);
  if (bytes.length > MAX_BYTES) {
    out = new TextDecoder().decode(bytes.slice(0, MAX_BYTES)).replace(/�$/, '');
    capped = true;
  }
  return { text: out, capped };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export const REDACTED = '[redacted]';

const named = (match: string, name: string, sign: string) => `${name}${sign} ${REDACTED}`;

const SECRETS: [RegExp, (match: string, ...groups: string[]) => string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => REDACTED],
  [/\b(authorization|proxy-authorization)\s*([:=])\s*("[^"\n]*"|'[^'\n]*'|[^\n]*)/gi, named],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, () => REDACTED],
  [/\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{16,}/g, () => REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => REDACTED],
  [/\bABSK[A-Za-z0-9+/=]{16,}/g, () => REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, () => REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, () => REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, () => REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, () => REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => REDACTED],
  [/(https?:\/\/[^\s#)]*)#[^\s)]*\bkey\b[^\s)]*/gi, (_match, url) => `${url}#${REDACTED}`],
  [
    /([?&][\w.-]*(?:sig|signature|token|key|secret|credential|password|auth|code)[\w.-]*=)[^&\s#)"']+/gi,
    (_match, name) => `${name}${REDACTED}`,
  ],
  [
    /\b((?:api|access|secret|private|client)[_-]?(?:key|token|secret)|token|password|passwd|secret)\s*([:=])\s*["']?[^\s"',;]{6,}["']?/gi,
    named,
  ],
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [pattern, replace] of SECRETS)
    out = out.replace(pattern, (match: string, ...groups: string[]) => {
      if (match.endsWith(REDACTED)) return match;
      count++;
      return replace(match, ...groups);
    });
  return { text: out, count };
}

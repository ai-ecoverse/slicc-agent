const FENCE = /^(`{3,}|~{3,})/;
const RULE = /^([-*_])(\s*\1){2,}$/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const SUMMARY = /^\s{0,3}#{1,6}\s+summary\s*#*\s*$/i;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;

type Line = { text: string; kind: 'blank' | 'heading' | 'item' | 'text' };

function plain(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s*)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/[\s#]+$/, '')
    .trim();
}

function scan(text: string): Line[] {
  const out: Line[] = [];
  let fenced = false;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (FENCE.test(trimmed)) {
      fenced = !fenced;
      out.push({ text: '', kind: 'blank' });
      continue;
    }
    if (fenced || RULE.test(trimmed) || trimmed.startsWith('|') || !trimmed) {
      out.push({ text: '', kind: 'blank' });
      continue;
    }
    const kind = HEADING.test(raw) ? 'heading' : ITEM.test(raw) ? 'item' : 'text';
    out.push({ text: raw, kind });
  }
  return out;
}

function paragraph(lines: readonly Line[], stopAtHeading: boolean): string {
  const taken: string[] = [];
  for (const line of lines) {
    if (line.kind === 'heading') {
      if (taken.length || stopAtHeading) break;
      continue;
    }
    if (line.kind === 'blank') {
      if (taken.length) break;
      continue;
    }
    if (line.kind === 'item') {
      if (taken.length) break;
      return plain(line.text);
    }
    taken.push(plain(line.text));
  }
  return taken.filter(Boolean).join(' ');
}

function sentence(text: string): string {
  const end = /[.!?](?=\s+[A-Z0-9"'(])/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

export function summarize(text: string): string {
  const lines = scan(text);
  const at = lines.findIndex((line) => line.kind === 'heading' && SUMMARY.test(line.text));
  const found =
    (at >= 0 ? paragraph(lines.slice(at + 1), true) : '') ||
    paragraph(lines, false) ||
    lines.map((line) => plain(line.text)).find(Boolean) ||
    '';
  return sentence(found);
}

export function cardOf(
  name: string,
  report: { text: string; failed: string | null; path: string | null }
): { summary: string; report?: string } {
  const said = report.failed ? '' : summarize(report.text);
  const ended = report.failed ? (report.failed === 'aborted' ? 'stopped' : 'failed') : 'finished';
  return {
    summary: said || `Scoop ${name} ${ended}`,
    ...(report.path ? { report: report.path } : {}),
  };
}

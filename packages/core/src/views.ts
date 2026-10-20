import { slugify, type Entry, type EntryMeta } from './entry.ts';

/** Entries not superseded by another entry. */
export function liveEntries(entries: Entry[]): Entry[] {
  const superseded = new Set<string>();
  for (const e of entries) for (const id of e.meta.supersedes) superseded.add(id);
  return entries.filter((e) => !superseded.has(e.meta.id));
}

/** The L1 page an entry belongs to. */
export function viewPathFor(meta: EntryMeta): string {
  if (meta.scope.startsWith('project:')) return `projects/${meta.scope.slice(8)}.md`;
  if (meta.scope.startsWith('machine:')) return `machines/${slugify(meta.scope.slice(8))}.md`;
  return `topics/${meta.type}.md`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

const newestFirst = (a: Entry, b: Entry) => b.meta.created.localeCompare(a.meta.created);
const SECTION_ORDER = ['projects/', 'topics/', 'machines/'];

/**
 * Renders L0 (INDEX.md) and L1 pages deterministically from live entries.
 * Views are never edited or synced; every device renders the same output.
 */
export function renderViews(entries: Entry[], opts = { indexLines: 150, pageLines: 300 }): Map<string, string> {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const p = viewPathFor(e.meta);
    groups.set(p, [...(groups.get(p) ?? []), e]);
  }
  const views = new Map<string, string>();
  const rows: { path: string; newest: string; line: string }[] = [];
  for (const [p, list] of groups) {
    list.sort(newestFirst);
    const name = p.replace(/\.md$/, '');
    const summary = list.find((e) => e.meta.type === 'summary');
    const items = list.filter((e) => e.meta.type !== 'summary');
    const lines = [`# ${name}`, ''];
    if (summary) lines.push(summary.meta.summary, '', ...summary.body.split('\n').slice(0, 60), '');
    lines.push(`## Entries (${items.length})`, '');
    for (const e of items) {
      lines.push(`- ${oneLine(e.meta.title, 100)} — ${oneLine(e.meta.summary, 160)} (\`${e.meta.id}\`, ${e.meta.source.device ?? '?'}, ${e.meta.created.slice(0, 10)})`);
    }
    if (lines.length > opts.pageLines) {
      const hidden = lines.length - opts.pageLines + 1;
      lines.length = opts.pageLines - 1;
      lines.push(`- … ${hidden} more entries: use rembo search`);
    }
    views.set(p, lines.join('\n') + '\n');
    const machines = [...new Set(list.map((e) => e.meta.source.device).filter(Boolean))].sort();
    const blurb = summary?.meta.summary ?? items[0]?.meta.title ?? '';
    rows.push({
      path: p,
      newest: list[0]!.meta.created,
      line: `- [${name}](${p}) — ${oneLine(blurb, 120)} · ${list.length} entries${machines.length ? ' · ' + machines.join(', ') : ''}`,
    });
  }
  const section = (p: string) => SECTION_ORDER.findIndex((s) => p.startsWith(s));
  rows.sort((a, b) => section(a.path) - section(b.path) || b.newest.localeCompare(a.newest) || a.path.localeCompare(b.path));
  const index = ['# rembo memory index', '', ...rows.map((r) => r.line)];
  if (index.length > opts.indexLines) {
    const hidden = index.length - opts.indexLines + 1;
    index.length = opts.indexLines - 1;
    index.push(`- … ${hidden} more pages: use rembo search`);
  }
  views.set('INDEX.md', index.join('\n') + '\n');
  return views;
}

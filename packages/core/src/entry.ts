import { RemboError } from './errors.ts';

export const ENTRY_TYPES = ['fact', 'decision', 'preference', 'howto', 'infra', 'doc', 'summary'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface EntrySource {
  origin: 'remember' | 'import' | 'native-memory';
  device?: string;
  path?: string;
  session?: string;
}

export interface EntryMeta {
  id: string;
  type: EntryType;
  title: string;
  summary: string;
  scope: string;
  tags: string[];
  source: EntrySource;
  created: string;
  author_device?: string;
  supersedes: string[];
}

export interface Entry {
  meta: EntryMeta;
  body: string;
  /** Frontmatter fields this version does not know (written by a newer rembo); kept as-is. */
  extra?: Record<string, unknown>;
}

const FIELD_ORDER: (keyof EntryMeta)[] = [
  'id', 'type', 'title', 'summary', 'scope', 'tags', 'source', 'created', 'author_device', 'supersedes',
];
const KNOWN_FIELDS = new Set<string>(FIELD_ORDER);
const EXTRA_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SCOPE_RE = /^(global|project:[a-z0-9][a-z0-9._-]*|machine:[a-z0-9][a-z0-9._-]*)$/;

export function isValidScope(scope: string): boolean {
  return SCOPE_RE.test(scope);
}

export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
  return slug || 'untitled';
}

function invalid(why: string): RemboError {
  return new RemboError('invalid_entry', `Invalid memory entry: ${why}.`);
}

/** Validates an entry and fills defaults; throws RemboError('invalid_entry'). */
export function validateEntry(input: { meta: Partial<EntryMeta>; body?: unknown }): Entry {
  const m = input.meta ?? {};
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw invalid('bad id');
  if (!ENTRY_TYPES.includes(m.type as EntryType)) throw invalid(`unknown type "${String(m.type)}"`);
  if (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 200) throw invalid('title must be 1-200 characters');
  if (typeof m.scope !== 'string' || !isValidScope(m.scope)) throw invalid(`bad scope "${String(m.scope)}"`);
  if (typeof m.created !== 'string' || Number.isNaN(Date.parse(m.created))) throw invalid('bad created date');
  const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
  const supersedes = Array.isArray(m.supersedes) ? m.supersedes.filter((s): s is string => typeof s === 'string' && ID_RE.test(s)) : [];
  const source: EntrySource = m.source && typeof m.source === 'object' ? m.source : { origin: 'remember' };
  const meta: EntryMeta = {
    id: m.id,
    type: m.type as EntryType,
    title: m.title.trim(),
    summary: typeof m.summary === 'string' && m.summary.trim() ? m.summary.trim() : m.title.trim(),
    scope: m.scope,
    tags,
    source,
    created: m.created,
    supersedes,
  };
  if (typeof m.author_device === 'string') meta.author_device = m.author_device;
  const entry: Entry = { meta, body: typeof input.body === 'string' ? input.body.trimEnd() : '' };
  const extra = Object.entries(m).filter(([k, v]) => !KNOWN_FIELDS.has(k) && EXTRA_KEY_RE.test(k) && v !== undefined);
  if (extra.length) entry.extra = Object.fromEntries(extra);
  return entry;
}

/** Markdown with frontmatter; every value is JSON (valid YAML flow syntax). */
export function entryToMarkdown(entry: Entry): string {
  const lines = ['---'];
  for (const key of FIELD_ORDER) {
    const value = entry.meta[key];
    if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  for (const [key, value] of Object.entries(entry.extra ?? {})) lines.push(`${key}: ${JSON.stringify(value)}`);
  lines.push('---', '');
  return lines.join('\n') + entry.body.trimEnd() + '\n';
}

export function entryFromMarkdown(text: string): Entry {
  const norm = text.replace(/\r\n/g, '\n');
  if (!norm.startsWith('---\n')) throw invalid('missing frontmatter');
  const end = norm.indexOf('\n---\n', 3);
  if (end < 0) throw invalid('unterminated frontmatter');
  const meta: Record<string, unknown> = {};
  for (const line of norm.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      meta[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      meta[line.slice(0, i).trim()] = raw;
    }
  }
  return validateEntry({ meta: meta as Partial<EntryMeta>, body: norm.slice(end + 5) });
}

export function entryToPlaintext(entry: Entry): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, meta: { ...entry.extra, ...entry.meta }, body: entry.body }), 'utf8');
}

export function entryFromPlaintext(data: Buffer): Entry {
  const obj = JSON.parse(data.toString('utf8')) as { v?: number; meta?: Partial<EntryMeta>; body?: unknown };
  if (obj?.v !== 1) throw invalid('unsupported format version');
  return validateEntry({ meta: obj.meta ?? {}, body: obj.body });
}

/** entries/YYYY/MM/<id>.md, from the creation date (UTC). */
export function entryRelPath(meta: Pick<EntryMeta, 'id' | 'created'>): string {
  const d = new Date(meta.created);
  return `entries/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${meta.id}.md`;
}

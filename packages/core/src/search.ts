import type { Entry } from './entry.ts';

export interface SearchHit {
  id: string;
  title: string;
  summary: string;
  type: string;
  scope: string;
  device: string | undefined;
  created: string;
  score: number;
  snippet: string;
}

export interface SearchOptions {
  scope?: string | undefined;
  limit?: number | undefined;
}

/** Search interface; the MVP backend scores in memory, later ones may add embeddings. */
export interface SearchBackend {
  index(entries: Entry[]): void;
  upsert(entry: Entry): void;
  remove(id: string): void;
  search(query: string, opts?: SearchOptions): SearchHit[];
}

export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

function counts(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tokenize(text)) map.set(t, (map.get(t) ?? 0) + 1);
  return map;
}

function prefixCount(map: Map<string, number>, prefix: string): number {
  let n = 0;
  for (const [t, c] of map) if (t.startsWith(prefix)) n += c;
  return n;
}

interface Doc {
  entry: Entry;
  title: Map<string, number>;
  tags: Map<string, number>;
  summary: Map<string, number>;
  body: Map<string, number>;
}

export class MemorySearch implements SearchBackend {
  private docs = new Map<string, Doc>();

  index(entries: Entry[]): void {
    this.docs.clear();
    for (const e of entries) this.upsert(e);
  }

  upsert(entry: Entry): void {
    this.docs.set(entry.meta.id, {
      entry,
      title: counts(entry.meta.title),
      tags: counts(entry.meta.tags.join(' ')),
      summary: counts(entry.meta.summary),
      body: counts(entry.body),
    });
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const scope = opts.scope;
    const hits: SearchHit[] = [];
    for (const d of this.docs.values()) {
      const m = d.entry.meta;
      if (scope && m.scope !== scope && !(scope.endsWith(':*') && m.scope.startsWith(scope.slice(0, -1)))) continue;
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        let s =
          5 * (d.title.get(t) ?? 0) + 4 * (d.tags.get(t) ?? 0) + 3 * (d.summary.get(t) ?? 0) + Math.min(5, d.body.get(t) ?? 0);
        if (s === 0 && t.length >= 3) {
          s = 0.5 * (5 * prefixCount(d.title, t) + 3 * prefixCount(d.summary, t) + Math.min(3, prefixCount(d.body, t)));
        }
        if (s > 0) matched++;
        score += s;
      }
      if (matched === 0) continue;
      score *= matched / terms.length;
      hits.push({
        id: m.id,
        title: m.title,
        summary: m.summary,
        type: m.type,
        scope: m.scope,
        device: m.source.device,
        created: m.created,
        score: Math.round(score * 100) / 100,
        snippet: snippet(d.entry.body, terms),
      });
    }
    hits.sort((a, b) => b.score - a.score || b.created.localeCompare(a.created));
    return hits.slice(0, opts.limit ?? 10);
  }
}

function snippet(body: string, terms: string[]): string {
  const lines = body.split('\n').filter((l) => l.trim());
  const line = lines.find((l) => tokenize(l).some((t) => terms.some((q) => t.startsWith(q)))) ?? lines[0] ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? flat.slice(0, 159) + '…' : flat;
}

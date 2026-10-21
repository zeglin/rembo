import { describe, expect, test } from 'vitest';
import { entryFromMarkdown, entryFromPlaintext, entryRelPath, entryToMarkdown, entryToPlaintext, slugify, validateEntry, type Entry } from '../src/entry.ts';
import { untrusted } from '../src/errors.ts';
import { redactSecrets, scanSecrets } from '../src/guard.ts';
import { normalizeGitRemote } from '../src/project.ts';
import { MemorySearch } from '../src/search.ts';
import { liveEntries, renderViews } from '../src/views.ts';

let n = 0;
function entry(over: Partial<Entry['meta']> = {}, body = ''): Entry {
  n++;
  return validateEntry({
    meta: {
      id: (over.id ?? `e${String(n).padStart(31, '0')}`),
      type: 'fact',
      title: `Title ${n}`,
      scope: 'global',
      created: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
      source: { origin: 'remember', device: 'laptop' },
      ...over,
    },
    body,
  });
}

describe('entries', () => {
  test('markdown round-trip keeps Windows paths and unicode', () => {
    const e = entry({ title: 'Scraper: gdzie leży?', tags: ['scraping'], source: { origin: 'import', device: 'pc', path: 'D:\\work\\scraper\\CLAUDE.md' } }, 'Run `python run.py --city waw`\n\n--- not frontmatter ---');
    const md = entryToMarkdown(e);
    expect(entryFromMarkdown(md)).toEqual(e);
    expect(entryFromMarkdown(md.replace(/\n/g, '\r\n'))).toEqual(e);
    expect(entryFromPlaintext(entryToPlaintext(e))).toEqual(e);
  });

  test('validation rejects bad scopes, types and ids', () => {
    expect(() => entry({ scope: 'project:Bad Slug' })).toThrow(/bad scope/);
    expect(() => entry({ type: 'nope' as never })).toThrow(/unknown type/);
    expect(() => entry({ id: 'short' })).toThrow(/bad id/);
  });

  test('paths and slugs', () => {
    expect(entryRelPath({ id: 'x'.repeat(32), created: '2026-03-05T10:00:00Z' })).toBe(`entries/2026/03/${'x'.repeat(32)}.md`);
    expect(slugify('Zażółć Gęślą — Jaźń!')).toBe('zazolc-gesla-jazn');
  });
});

describe('views', () => {
  test('superseded entries disappear; newest summary leads the page', () => {
    const old = entry({ scope: 'project:shop', title: 'Old fact' });
    const fix = entry({ scope: 'project:shop', title: 'Corrected fact', supersedes: [old.meta.id] });
    const s1 = entry({ scope: 'project:shop', type: 'summary', title: 'Shop', summary: 'old overview' });
    const s2 = entry({ scope: 'project:shop', type: 'summary', title: 'Shop', summary: 'Online shop backend, deployed on vps-2' });
    const pref = entry({ type: 'preference', title: 'Prefers pnpm' });
    const views = renderViews(liveEntries([old, fix, s1, s2, pref]));
    const page = views.get('projects/shop.md')!;
    expect(page).toContain('Corrected fact');
    expect(page).not.toContain('Old fact');
    expect(page.split('\n')[2]).toBe('Online shop backend, deployed on vps-2');
    const index = views.get('INDEX.md')!.split('\n');
    expect(index[2]).toMatch(/^- \[projects\/shop\]\(projects\/shop\.md\) — Online shop backend/);
    expect(views.get('topics/preference.md')).toContain('Prefers pnpm');
  });

  test('index is capped', () => {
    const many = Array.from({ length: 200 }, (_, i) => entry({ scope: `project:p${i}` }));
    expect(renderViews(many).get('INDEX.md')!.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
  });
});

describe('secret guard', () => {
  const cases: [string, string][] = [
    ['private-key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['aws-access-key', 'key AKIAIOSFODNN7EXAMPLE here'],
    ['github-token', 'ghp_' + 'a1B2'.repeat(9)],
    ['anthropic-key', 'sk-ant-api03-' + 'x'.repeat(30)],
    ['openai-key', 'sk-proj-' + 'Ab1'.repeat(12)],
    ['stripe-key', 'sk_live_' + '4eC39HqLyjWDarjtT1zdp7dc'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['url-credentials', 'postgres://admin:hunter22@db.internal:5432/app'],
    ['password-assignment', 'password = "Tr0ub4dor&3"'],
    ['high-entropy', 'token Zx9Qp2Lm8Rt4Vb7Nc1Kd6Hs3Jf5Gw0Ye'],
  ];
  for (const [rule, text] of cases) {
    test(`detects ${rule}`, () => expect(scanSecrets(`line one\n${text}`).map((f) => f.rule)).toContain(rule));
  }

  test('no false positives on ordinary notes and password-manager pointers', () => {
    const text = [
      'The scraper lives in D:\\work\\scraper; run python run.py --city waw',
      'login: KeePassXC entry "shop-admin"',
      'password: KeePassXC entry shop-admin',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b, entry id 0123456789abcdef0123456789abcdef',
      'https://github.com/example/repo/blob/main/src/very/long/path/name.ts',
    ].join('\n');
    expect(scanSecrets(text)).toEqual([]);
  });

  test('redaction reports position, never the value', () => {
    const { text, findings } = redactSecrets('ok\ndb: postgres://u:pa55word@host/x');
    expect(text).toBe('ok\ndb: [REDACTED:url-credentials]host/x');
    expect(findings).toEqual([{ rule: 'url-credentials', line: 2, column: 5 }]);
  });
});

describe('search', () => {
  test('ranks title matches, folds Polish diacritics, filters scope', () => {
    const s = new MemorySearch();
    const a = entry({ title: 'Scraper nieruchomości', scope: 'project:estate' }, 'uruchamianie: python run.py');
    const b = entry({ title: 'Deploy notes' }, 'the scraper is deployed by cron');
    s.index([a, b, entry({ title: 'Unrelated' })]);
    const hits = s.search('scraper nieruchomosci');
    expect(hits[0]!.id).toBe(a.meta.id);
    expect(hits.map((h) => h.id)).toContain(b.meta.id);
    expect(s.search('scraper', { scope: 'global' }).map((h) => h.id)).toEqual([b.meta.id]);
    expect(s.search('scrap')[0]!.id).toBe(a.meta.id); // prefix
    expect(s.search('zzzz')).toEqual([]);
  });

  test('searches 10,000 entries within the 200 ms budget', () => {
    const words = 'alpha beta gamma delta scraper deploy server client vault memory index backup proxy docker node python'.split(' ');
    const entries = Array.from({ length: 10_000 }, (_, i) =>
      entry({ id: `p${String(i).padStart(31, '0')}`, title: `${words[i % 16]} ${words[(i * 7) % 16]} note ${i}` }, Array.from({ length: 40 }, (_, j) => words[(i + j) % 16]).join(' ')),
    );
    const s = new MemorySearch();
    s.index(entries);
    const started = performance.now();
    const hits = s.search('scraper python deployment');
    const ms = performance.now() - started;
    expect(hits.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });
});

describe('project identity', () => {
  test('normalizes git remotes', () => {
    expect(normalizeGitRemote('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo');
    expect(normalizeGitRemote('https://github.com/owner/repo')).toBe('github.com/owner/repo');
    expect(normalizeGitRemote('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toBe('gitlab.example.com/group/sub/repo');
    expect(normalizeGitRemote('not a url')).toBeNull();
  });
});

describe('forward compatibility and untrusted text', () => {
  test('frontmatter fields from a newer version survive markdown and plaintext round trips', () => {
    const base = entry();
    const newer = validateEntry({ meta: { ...base.meta, expires: '2030-01-01', 'Bad Key': 1 } as never, body: 'b' });
    expect(newer.extra).toEqual({ expires: '2030-01-01' });
    expect(entryFromMarkdown(entryToMarkdown(newer)).extra).toEqual({ expires: '2030-01-01' });
    expect(entryFromPlaintext(entryToPlaintext(newer)).extra).toEqual({ expires: '2030-01-01' });
  });

  test('untrusted text loses escape sequences and is bounded', () => {
    expect(untrusted('ok\u001b[2J\u001b]0;pwned\u0007 done\u202e')).toBe('ok [2J ]0;pwned done');
    expect(untrusted('x'.repeat(500)).length).toBe(300);
  });
});

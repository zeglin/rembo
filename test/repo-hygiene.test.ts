import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Invisible characters in source ("Trojan Source": bidi overrides, zero-width
// characters, raw control codes) hide what code does from reviewers. Tests that
// need them write escapes. The class is built from code points so this file
// cannot contain them either.
const ranges: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
const invisible = new RegExp(`[${ranges.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`);

test('tracked text files contain no invisible or bidi control characters', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml)$/.test(f) && !f.endsWith('package-lock.json'));
  const offenders = files.filter((f) => invisible.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});

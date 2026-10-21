/** An error with a stable code and a hint telling the user what to do next. */
export class RemboError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'RemboError';
    this.code = code;
    this.hint = hint;
  }
}

export function isRemboError(e: unknown): e is RemboError {
  return e instanceof RemboError;
}

const INVISIBLE_RANGES: [number, number][] = [
  [0x00, 0x08], // C0 controls except tab and newline
  [0x0b, 0x1f],
  [0x7f, 0x9f], // DEL and C1 controls
  [0xad, 0xad], // soft hyphen
  [0x200b, 0x200f], // zero-width characters, direction marks
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

/**
 * Characters that are invisible or steer layout. Built from code points, so
 * this source file contains none of them (see test/repo-hygiene.test.ts).
 */
export const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`,
  'g',
);

/**
 * Text from an untrusted source (the hub, another device's name) made safe to
 * print or hand to a model: no control or escape sequences, bounded length.
 */
export function untrusted(text: unknown, max = 300): string {
  const flat = String(text ?? '').replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

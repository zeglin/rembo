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

/**
 * Text from an untrusted source (the hub, another device's name) made safe to
 * print or hand to a model: no control or escape sequences, bounded length.
 */
export function untrusted(text: unknown, max = 300): string {
  const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

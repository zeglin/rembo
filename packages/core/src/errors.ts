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

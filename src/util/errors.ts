/** A problem with how the CLI was invoked (exit code 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Raised when code tries to send anything but a GET or a registered read-only HogQL query. */
export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(`Refusing non-read-only request: ${message}`);
    this.name = 'ReadOnlyViolation';
  }
}

/** A failed PostHog API call. Messages are already redacted. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly path: string;
  readonly code: string | null;

  constructor(message: string, options: { status: number | null; path: string; code?: string | null }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.path = options.path;
    this.code = options.code ?? null;
  }

  /** 401: bad key — nothing else will work, so collection stops. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

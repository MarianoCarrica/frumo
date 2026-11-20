import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * Holds the API key so it can't leak by accident: string conversion, JSON serialization and
 * console/util.inspect all print "[REDACTED]". Only `reveal()` returns the value, and only the
 * HTTP client calls it (to build the Authorization header).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

/**
 * Credential formats: PostHog personal (phx_), project secret (phs_), OAuth (pha_/phr_), project
 * token (phc_); Sentry user (sntryu_) and organization (sntrys_) auth tokens.
 */
const TOKEN_PATTERN = /\bph[xsarc]_[A-Za-z0-9_-]{6,}|\bsntry[us]_[A-Za-z0-9_+/=-]{6,}/g;

/**
 * Removes credentials from text that may be shown to the user or written somewhere:
 * the given secret values, anything that looks like a PostHog key, and Authorization headers.
 */
export function redact(text: string, secrets: ReadonlyArray<Secret | string> = []): string {
  let out = text;
  for (const s of secrets) {
    const value = typeof s === 'string' ? s : s.reveal();
    if (value.length >= 4) out = out.split(value).join(REDACTED);
  }
  out = out.replace(TOKEN_PATTERN, (m) => `${m.slice(0, 4)}${REDACTED}`);
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s,"'}]+/gi, `$1${REDACTED}`);
  return out;
}

/** True when a CLI argument looks like a pasted credential (which would land in shell history). */
export function looksLikeCredential(arg: string): boolean {
  return /(^|[=\s])ph[xsar]_[A-Za-z0-9]{20,}($|\s)/.test(arg) || /(^|[=\s])sntry[us]_[A-Za-z0-9_+/=-]{20,}($|\s)/.test(arg);
}

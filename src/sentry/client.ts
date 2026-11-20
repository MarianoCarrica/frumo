/**
 * Read-only Sentry API client for `frumo sentry`.
 *
 * It can do exactly one thing: GET /api/0/... on the configured Sentry host. Any other method,
 * path or origin throws ReadOnlyViolation before a request is made. Redirects are not followed
 * (so the token is never forwarded to another host), requests are sequential, 429s are retried
 * after Retry-After, and every error message is redacted.
 */
import { defaultSleep, parseRetryAfter } from '../sources/live/client.js';
import { ApiError, ReadOnlyViolation, UsageError } from '../util/errors.js';
import { redact } from '../util/secret.js';
import type { Secret } from '../util/secret.js';
import { SENTRY_TOKEN_ENV } from './auth-token.js';

export const DEFAULT_SENTRY_HOST = 'https://sentry.io';

export interface SentryClientOptions {
  /** Normalized origin, e.g. https://sentry.io */
  origin: string;
  token: Secret;
  toolVersion: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Verbose request log (method, path, status). Never receives headers, query strings or bodies. */
  log?: (line: string) => void;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryAfterSeconds?: number;
  minIntervalMs?: number;
}

export type QueryValue = string | number | readonly string[] | undefined;

export interface Page<T> {
  data: T;
  /** Next page URL from the Link header, when Sentry says there are more results. */
  next: string | null;
}

/** The read-only rule, checked before every request: GET only, under /api/0/, no body. */
export function assertSentryReadOnly(method: string, url: URL, body: unknown): void {
  if (method !== 'GET') throw new ReadOnlyViolation(`${method} is not allowed; frumo sentry only sends GET`);
  if (body !== undefined) throw new ReadOnlyViolation('GET with a body');
  if (!url.pathname.startsWith('/api/0/')) throw new ReadOnlyViolation(`path outside /api/0/: ${url.pathname}`);
}

export class SentryReadOnlyClient {
  readonly origin: string;
  private readonly token: Secret;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly minIntervalMs: number;
  private readonly userAgent: string;
  private lastRequestAt = 0;
  requestCount = 0;

  constructor(options: SentryClientOptions) {
    this.origin = options.origin.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (() => undefined);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.userAgent = `frumo/${options.toolVersion} (read-only billing audit)`;
    if (typeof this.fetchImpl !== 'function') throw new Error('global fetch is unavailable: frumo needs Node.js 18 or newer.');
  }

  /** GET /api/0/... and parse JSON. Arrays in `query` become repeated parameters. */
  async get<T = unknown>(path: string, query: Record<string, QueryValue> = {}, scope?: string): Promise<Page<T>> {
    const url = this.url(path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number') url.searchParams.append(k, String(v));
      else for (const item of v) url.searchParams.append(k, item);
    }
    return this.request<T>(url, scope);
  }

  /** Follows a Link-header `next` URL; it must stay on the same origin and API. */
  async getNext<T = unknown>(nextUrl: string, scope?: string): Promise<Page<T>> {
    let url: URL;
    try {
      url = new URL(nextUrl);
    } catch {
      throw new ApiError('Invalid pagination URL from Sentry', { status: null, path: '(next)' });
    }
    if (url.origin !== this.origin) {
      throw new ApiError(`Sentry returned a pagination link to another host (${url.origin}); not following it.`, { status: null, path: url.pathname });
    }
    return this.request<T>(this.url(url.pathname + url.search), scope);
  }

  private url(path: string): URL {
    if (!path.startsWith('/api/0/')) throw new ReadOnlyViolation(`path must start with /api/0/: ${path}`);
    return new URL(path, `${this.origin}/`);
  }

  private async request<T>(url: URL, scope: string | undefined): Promise<Page<T>> {
    assertSentryReadOnly('GET', url, undefined);
    if (url.origin !== this.origin) throw new ReadOnlyViolation(`request to unexpected origin ${url.origin}`);
    const label = `GET ${url.pathname}`;
    let attempt = 0;
    for (;;) {
      await this.pace();
      const started = Date.now();
      let response: Response;
      try {
        this.requestCount += 1;
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token.reveal()}`, Accept: 'application/json', 'User-Agent': this.userAgent },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), [this.token]);
        if (attempt < this.maxRetries) {
          attempt += 1;
          const wait = backoffMs(attempt);
          this.log(`${label} failed (${message}); retrying in ${wait / 1000}s`);
          await this.sleep(wait);
          continue;
        }
        throw new ApiError(`${label} failed: ${message}`, { status: null, path: url.pathname });
      }
      this.log(`${label} → ${response.status} (${Date.now() - started} ms)`);

      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw new ApiError(`${label} was redirected; frumo does not follow redirects so your token stays on the host you chose.`, {
          status: response.status,
          path: url.pathname,
        });
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
        if (attempt < this.maxRetries) {
          if (retryAfter !== null && retryAfter > this.maxRetryAfterSeconds) {
            throw new ApiError(`${label}: Sentry rate limit (429). It asked to wait ${Math.ceil(retryAfter)}s; try again later.`, {
              status: 429,
              path: url.pathname,
              code: 'rate_limited',
            });
          }
          attempt += 1;
          const wait = retryAfter !== null ? Math.ceil(retryAfter * 1000) : backoffMs(attempt);
          this.log(`${label} → ${response.status}; retrying in ${(wait / 1000).toFixed(1)}s`);
          await response.body?.cancel().catch(() => undefined);
          await this.sleep(wait);
          continue;
        }
      }

      const text = await response.text();
      if (!response.ok) throw this.errorFor(response.status, text, label, url.pathname, scope);
      let data: T;
      try {
        data = JSON.parse(text) as T;
      } catch {
        throw new ApiError(`${label}: Sentry returned something that isn't JSON (status ${response.status}).`, { status: response.status, path: url.pathname });
      }
      return { data, next: nextLink(response.headers.get('link')) };
    }
  }

  private errorFor(status: number, text: string, label: string, path: string, scope: string | undefined): ApiError {
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { detail?: unknown };
      detail = typeof parsed.detail === 'string' ? parsed.detail : '';
    } catch {
      detail = text.slice(0, 200);
    }
    let message = `${label} → ${status}${detail ? `: ${detail}` : ''}`;
    if (status === 401) message = `${label} → 401: Sentry rejected the token in ${SENTRY_TOKEN_ENV} (invalid, expired or revoked).`;
    else if (status === 403) message += scope ? ` (the token probably lacks the ${scope} scope, or access to this organization/project)` : '';
    else if (status === 404) message += ' (not found: check --org)';
    return new ApiError(redact(message, [this.token]), { status, path });
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (this.lastRequestAt > 0 && wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

/** Parses Sentry's Link header and returns the next URL when `results="true"`. */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>(.*)$/.exec(part.trim());
    if (!m) continue;
    const attrs = m[2] ?? '';
    if (/rel="?next"?/.test(attrs) && /results="?true"?/.test(attrs)) return m[1] ?? null;
  }
  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(16_000, 1_000 * 2 ** (attempt - 1));
}

/** Validates --host for Sentry: https origin only (self-hosted Sentry works too). */
export function normalizeSentryHost(input: string): string {
  const raw = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`--host "${raw}" is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new UsageError('--host must use https:// (the token is sent to it)');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new UsageError(`--host should be just the origin, e.g. ${url.origin}`);
  }
  return url.origin;
}

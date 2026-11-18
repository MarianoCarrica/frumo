/**
 * Read-only PostHog API client.
 *
 * It can only do two things:
 *   1. GET requests to /api/... on the configured host;
 *   2. POST /api/projects/:id/query/ with a HogQL SELECT built by ./queries.ts.
 * Anything else throws ReadOnlyViolation before a request is made. Redirects are not followed
 * (so the key is never forwarded to another host), requests are sequential, 429s are retried
 * after Retry-After, and every error message is redacted.
 */
import { ApiError, ReadOnlyViolation } from '../../util/errors.js';
import { Secret, redact } from '../../util/secret.js';
import { isIssuedQuery, isSingleSelect } from './queries.js';
import type { HogQLQuery } from './queries.js';

export interface ClientOptions {
  /** Normalized origin, e.g. https://us.posthog.com */
  origin: string;
  apiKey: Secret;
  toolVersion: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Verbose request log (method, path, status). Never receives headers or bodies. */
  log?: (line: string) => void;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest Retry-After HogPost is willing to wait. */
  maxRetryAfterSeconds?: number;
  /** Pause between consecutive requests. */
  minIntervalMs?: number;
  /** Longest time to wait for an async query to finish. */
  queryTimeoutMs?: number;
}

type Method = 'GET' | 'POST';

interface RequestOptions {
  /** Scope to mention when PostHog answers 403. */
  scope?: string;
}

const QUERY_PATH = /^\/api\/(projects|environments)\/\d+\/query\/?$/;
const QUERY_STATUS_PATH = /^\/api\/(projects|environments)\/\d+\/query\/[A-Za-z0-9_-]+\/?$/;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PostHogReadOnlyClient {
  readonly origin: string;
  private readonly apiKey: Secret;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly minIntervalMs: number;
  private readonly queryTimeoutMs: number;
  private readonly userAgent: string;
  private lastRequestAt = 0;
  /** Count of requests actually sent (for tests and the summary line). */
  requestCount = 0;

  constructor(options: ClientOptions) {
    this.origin = options.origin.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.log = options.log ?? (() => undefined);
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 120_000;
    this.userAgent = `hogpost/${options.toolVersion} (read-only billing audit)`;
    if (typeof this.fetchImpl !== 'function') throw new Error('global fetch is unavailable: HogPost needs Node.js 18 or newer.');
  }

  /** GET /api/... and parse JSON. */
  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    return (await this.request('GET', url, undefined, options)) as T;
  }

  /** Follows a pagination `next` URL; it must point at the same origin and API. */
  async getNext<T = unknown>(nextUrl: string, options: RequestOptions = {}): Promise<T> {
    let url: URL;
    try {
      url = new URL(nextUrl);
    } catch {
      throw new ApiError(`Invalid pagination URL from PostHog`, { status: null, path: '(next)' });
    }
    if (url.origin !== this.origin) {
      throw new ApiError(`PostHog returned a pagination link to another host (${url.origin}); not following it.`, { status: null, path: url.pathname });
    }
    return (await this.request('GET', this.url(url.pathname + url.search), undefined, options)) as T;
  }

  /** Runs one registered HogQL SELECT and returns rows as objects keyed by column name. */
  async hogql(projectId: string, query: HogQLQuery): Promise<Array<Record<string, unknown>>> {
    if (!isIssuedQuery(query)) throw new ReadOnlyViolation('only the hard-coded queries in queries.ts may be sent');
    if (!/^\d+$/.test(projectId)) throw new ReadOnlyViolation(`invalid project id "${projectId}"`);
    const body = JSON.stringify({ query: { kind: 'HogQLQuery', query: query.sql }, name: query.name, refresh: 'blocking' });
    let response = await this.request('POST', this.url(`/api/projects/${projectId}/query/`), body, { scope: 'query:read' });

    const deadline = Date.now() + this.queryTimeoutMs;
    let delay = 1_000;
    while (isPending(response)) {
      if (Date.now() > deadline) throw new ApiError(`Query ${query.name} did not finish in ${this.queryTimeoutMs / 1000}s`, { status: null, path: 'query' });
      const id = String((response as { query_status: { id: unknown } }).query_status.id ?? '');
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ApiError('PostHog returned an invalid query id', { status: null, path: 'query' });
      await this.sleep(delay);
      delay = Math.min(delay * 2, 5_000);
      response = await this.request('GET', this.url(`/api/projects/${projectId}/query/${id}/`), undefined, { scope: 'query:read' });
    }
    return rowsFromQueryResponse(response, query.name);
  }

  private url(path: string): URL {
    if (!path.startsWith('/api/')) throw new ReadOnlyViolation(`path must start with /api/: ${path}`);
    return new URL(path, `${this.origin}/`);
  }

  private async request(method: Method, url: URL, body: string | undefined, options: RequestOptions): Promise<unknown> {
    assertReadOnly(method, url, body);
    if (url.origin !== this.origin) throw new ReadOnlyViolation(`request to unexpected origin ${url.origin}`);
    const label = `${method} ${url.pathname}`;
    let attempt = 0;
    for (;;) {
      await this.pace();
      const started = Date.now();
      let response: Response;
      try {
        this.requestCount += 1;
        response = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey.reveal()}`,
            Accept: 'application/json',
            'User-Agent': this.userAgent,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body } : {}),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error), [this.apiKey]);
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
        const location = response.headers.get('location');
        let hint = '';
        if (location) {
          try {
            hint = ` Re-run with --host ${new URL(location, url).origin}`;
          } catch {
            hint = '';
          }
        }
        throw new ApiError(`${label} was redirected; HogPost does not follow redirects so your key stays on the host you chose.${hint}`, {
          status: response.status,
          path: url.pathname,
        });
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
        if (attempt < this.maxRetries) {
          if (retryAfter !== null && retryAfter > this.maxRetryAfterSeconds) {
            throw new ApiError(
              `${label}: PostHog rate limit (429). It asked to wait ${Math.ceil(retryAfter)}s, longer than HogPost waits (${this.maxRetryAfterSeconds}s). Try again later, or read less with --days 7.`,
              { status: 429, path: url.pathname, code: 'rate_limited' },
            );
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
      if (!response.ok) throw this.errorFor(response.status, text, label, url.pathname, options);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ApiError(`${label}: PostHog returned something that isn't JSON (status ${response.status}). Is --host a PostHog instance?`, {
          status: response.status,
          path: url.pathname,
        });
      }
    }
  }

  private errorFor(status: number, text: string, label: string, path: string, options: RequestOptions): ApiError {
    let code: string | null = null;
    let detail = '';
    try {
      const parsed = JSON.parse(text) as { code?: unknown; detail?: unknown; error?: unknown };
      code = typeof parsed.code === 'string' ? parsed.code : null;
      detail = typeof parsed.detail === 'string' ? parsed.detail : typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      detail = text.slice(0, 200);
    }
    detail = redact(detail, [this.apiKey]);
    let message = `${label} → ${status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
    if (status === 401) message = `${label} → 401: PostHog rejected the API key in HOGPOST_API_KEY (invalid, revoked, or for another region/host).`;
    else if (status === 403) message += options.scope ? ` (the key probably lacks the ${options.scope} scope, or access to this project)` : '';
    else if (status === 404) message += ' (not found: check --project and --host)';
    return new ApiError(redact(message, [this.apiKey]), { status, path, code });
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (this.lastRequestAt > 0 && wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }
}

/**
 * The read-only rule, checked before every request:
 * GET anything under /api/; POST only a registered HogQL SELECT to the query endpoint.
 */
export function assertReadOnly(method: string, url: URL, body: string | undefined): void {
  if (!url.pathname.startsWith('/api/')) throw new ReadOnlyViolation(`path outside /api/: ${url.pathname}`);
  if (method === 'GET') {
    if (body !== undefined) throw new ReadOnlyViolation('GET with a body');
    return;
  }
  if (method !== 'POST') throw new ReadOnlyViolation(`${method} is not allowed`);
  if (!QUERY_PATH.test(url.pathname)) throw new ReadOnlyViolation(`POST is only allowed to the query endpoint, not ${url.pathname}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new ReadOnlyViolation('query body is not JSON');
  }
  const query = (parsed as { query?: { kind?: unknown; query?: unknown } }).query;
  if (!query || query.kind !== 'HogQLQuery' || typeof query.query !== 'string' || !isSingleSelect(query.query)) {
    throw new ReadOnlyViolation('only HogQL SELECT queries may be posted');
  }
}

export function isQueryStatusPath(pathname: string): boolean {
  return QUERY_STATUS_PATH.test(pathname);
}

function isPending(response: unknown): boolean {
  const status = (response as { query_status?: { complete?: unknown; error?: unknown; error_message?: unknown } } | null)?.query_status;
  if (!status || typeof status !== 'object') return false;
  if (status.error === true || typeof status.error_message === 'string') {
    throw new ApiError(`Query failed in PostHog: ${String(status.error_message ?? 'unknown error')}`, { status: null, path: 'query' });
  }
  return status.complete !== true;
}

/** Turns { columns, results } (or a completed query_status) into row objects. */
export function rowsFromQueryResponse(response: unknown, name: string): Array<Record<string, unknown>> {
  let payload = response as { columns?: unknown; results?: unknown; query_status?: { results?: unknown } } | null;
  if (payload && payload.query_status && typeof payload.query_status === 'object') {
    const inner = payload.query_status.results;
    payload = Array.isArray(inner) ? { columns: (payload as { columns?: unknown }).columns, results: inner } : (inner as typeof payload);
  }
  if (!payload || !Array.isArray(payload.results) || !Array.isArray(payload.columns)) {
    throw new ApiError(`Query ${name}: unexpected response shape from PostHog`, { status: null, path: 'query' });
  }
  const columns = payload.columns.map(String);
  return payload.results.map((row) => {
    const values = Array.isArray(row) ? row : [];
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      obj[c] = values[i];
    });
    return obj;
  });
}

/** Retry-After: seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now) / 1000);
}

function backoffMs(attempt: number): number {
  return Math.min(16_000, 1_000 * 2 ** (attempt - 1));
}

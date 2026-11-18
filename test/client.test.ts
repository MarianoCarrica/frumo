import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PostHogReadOnlyClient, assertReadOnly, parseRetryAfter, rowsFromQueryResponse } from '../src/sources/live/client.js';
import { normalizeHost } from '../src/sources/live/hosts.js';
import { buildQueries, isSingleSelect } from '../src/sources/live/queries.js';
import { ApiError, ReadOnlyViolation, UsageError } from '../src/util/errors.js';
import { Secret, looksLikeCredential, redact } from '../src/util/secret.js';
import { json, mockFetch } from './helpers.js';

const KEY = 'phx_TESTKEYabcdefghijklmnopqrstuvwxyz0123456789';
const ORIGIN = 'https://us.posthog.com';

function client(route: Parameters<typeof mockFetch>[0], options: { sleeps?: number[]; maxRetryAfterSeconds?: number } = {}) {
  const mock = mockFetch(route);
  const sleeps = options.sleeps ?? [];
  const c = new PostHogReadOnlyClient({
    origin: ORIGIN,
    apiKey: new Secret(KEY),
    toolVersion: 'test',
    fetchImpl: mock.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    minIntervalMs: 0,
    ...(options.maxRetryAfterSeconds !== undefined ? { maxRetryAfterSeconds: options.maxRetryAfterSeconds } : {}),
  });
  return { client: c, calls: mock.calls, sleeps };
}

const query = () => buildQueries(30)[0]!;

describe('read-only client', () => {
  it('sends GETs with the key only in the Authorization header and never follows redirects', async () => {
    const { client: c, calls } = client(() => json({ ok: true }));
    await c.get('/api/projects/1/', { a: 1 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url.toString()).toBe(`${ORIGIN}/api/projects/1/?a=1`);
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.redirect).toBe('manual');
    expect(call.url.toString()).not.toContain(KEY);
    expect(call.headers['user-agent']).toMatch(/^hogpost\/test/);
  });

  it('posts only registered HogQL SELECTs to the query endpoint', async () => {
    const { client: c, calls } = client(() => json({ columns: ['billable'], results: [[42]] }));
    const rows = await c.hogql('123', query());
    expect(rows).toEqual([{ billable: 42 }]);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/api/projects/123/query/');
    const body = JSON.parse(call.body ?? '{}') as { query: { kind: string; query: string }; name: string };
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).toBe(query().sql);
    expect(body.name).toBe('hogpost_totals');
  });

  it('refuses forged queries, other methods, other paths and other hosts before any request', async () => {
    const { client: c, calls } = client(() => json({}));
    const forged = { id: 'totals', name: 'x', purpose: 'x', sql: 'SELECT 1' } as const;
    await expect(c.hogql('1', forged)).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(c.hogql('1 OR 1', query())).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(c.get('/admin/')).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(c.getNext('https://evil.example/api/projects/1/feature_flags/?page=2')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(0);

    const url = new URL(`${ORIGIN}/api/projects/1/query/`);
    const body = JSON.stringify({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } });
    for (const method of ['PUT', 'PATCH', 'DELETE']) expect(() => assertReadOnly(method, url, body)).toThrow(ReadOnlyViolation);
    expect(() => assertReadOnly('POST', new URL(`${ORIGIN}/api/projects/1/feature_flags/`), body)).toThrow(/only allowed to the query endpoint/);
    expect(() => assertReadOnly('POST', url, JSON.stringify({ query: { kind: 'HogQLQuery', query: 'DELETE FROM events' } }))).toThrow(ReadOnlyViolation);
    expect(() => assertReadOnly('POST', url, JSON.stringify({ query: { kind: 'EventsQuery', select: ['*'] } }))).toThrow(ReadOnlyViolation);
    expect(() => assertReadOnly('GET', new URL(`${ORIGIN}/api/x/`), 'body')).toThrow(/GET with a body/);
    expect(() => assertReadOnly('POST', url, body)).not.toThrow();
  });

  it('only registers single SELECT statements', () => {
    for (const q of buildQueries(7)) expect(isSingleSelect(q.sql), q.id).toBe(true);
    expect(isSingleSelect('SELECT 1; DROP TABLE events')).toBe(false);
    expect(isSingleSelect("SELECT ';'")).toBe(true);
    expect(isSingleSelect('INSERT INTO events SELECT 1')).toBe(false);
    expect(isSingleSelect('SELECT 1 FROM events WHERE 1 IN (ALTER TABLE x)')).toBe(false);
    expect(() => buildQueries(0)).toThrow(UsageError);
    expect(() => buildQueries(91)).toThrow(UsageError);
    expect(() => buildQueries(7.5)).toThrow(UsageError);
  });

  it('waits for Retry-After on 429 and then retries', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { client: c, calls } = client(
      () => (++n === 1 ? new Response('{"detail":"Request was throttled."}', { status: 429, headers: { 'retry-after': '3' } }) : json({ ok: 1 })),
      { sleeps },
    );
    await expect(c.get('/api/billing/')).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toContain(3000);
  });

  it('gives up with advice when PostHog asks to wait too long', async () => {
    const { client: c, calls } = client(() => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }), { maxRetryAfterSeconds: 60 });
    await expect(c.get('/api/billing/')).rejects.toThrow(/asked to wait 3600s.*--days 7/s);
    expect(calls).toHaveLength(1);
  });

  it('backs off exponentially on 5xx and stops after the retry budget', async () => {
    const sleeps: number[] = [];
    const { client: c, calls } = client(() => new Response('oops', { status: 502 }), { sleeps });
    await expect(c.get('/api/billing/')).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
  });

  it('reports a redirect instead of following it (the key stays on the chosen host)', async () => {
    const { client: c, calls } = client(() => new Response(null, { status: 301, headers: { location: 'https://eu.posthog.com/api/billing/' } }));
    await expect(c.get('/api/billing/')).rejects.toThrow(/--host https:\/\/eu\.posthog\.com/);
    expect(calls).toHaveLength(1);
  });

  it('explains 401 and 403 and never echoes the key', async () => {
    const { client: c401 } = client(() => json({ detail: `Invalid key ${KEY}` }, 401));
    const e401 = await c401.get('/api/billing/').catch((e: unknown) => e);
    expect(e401).toBeInstanceOf(ApiError);
    expect((e401 as ApiError).isAuthFailure).toBe(true);
    expect((e401 as Error).message).not.toContain(KEY);

    const { client: c403 } = client(() => json({ type: 'authentication_error', code: 'permission_denied', detail: `scope missing for ${KEY}` }, 403));
    const e403 = (await c403.get('/api/billing/', {}, { scope: 'billing:read' }).catch((e: unknown) => e)) as Error;
    expect(e403.message).toMatch(/billing:read/);
    expect(e403.message).not.toContain(KEY);
    expect(e403.message).toContain('[REDACTED]');
  });

  it('polls async queries with GET until they complete', async () => {
    let polls = 0;
    const { client: c, calls } = client((call) => {
      if (call.method === 'POST') return json({ query_status: { id: 'abc123', complete: false } });
      polls += 1;
      return polls < 2
        ? json({ query_status: { id: 'abc123', complete: false } })
        : json({ query_status: { id: 'abc123', complete: true, results: { columns: ['n'], results: [[7]] } } });
    });
    await expect(c.hogql('9', query())).resolves.toEqual([{ n: 7 }]);
    expect(calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(['POST /api/projects/9/query/', 'GET /api/projects/9/query/abc123/', 'GET /api/projects/9/query/abc123/']);
  });

  it('surfaces query errors from PostHog', async () => {
    const { client: c } = client(() => json({ query_status: { id: 'x', complete: true, error: true, error_message: 'Timeout' } }));
    await expect(c.hogql('9', query())).rejects.toThrow(/Timeout/);
    expect(() => rowsFromQueryResponse({ nope: true }, 'q')).toThrow(/unexpected response shape/);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(parseRetryAfter('Wed, 18 Nov 2026 12:00:30 GMT', now)).toBe(30);
  });
});

describe('API key handling', () => {
  it('never prints the key through String(), JSON or util.inspect', () => {
    const secret = new Secret(KEY);
    // String() covers template literals and concatenation too: all three call toString().
    expect(String(secret)).toBe('[REDACTED]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect({ secret })).not.toContain(KEY);
    expect(secret.reveal()).toBe(KEY);
  });

  it('redacts the key, anything shaped like a PostHog key, and Authorization headers', () => {
    expect(redact(`failed with ${KEY}`, [new Secret(KEY)])).toBe('failed with [REDACTED]');
    expect(redact('token phs_abcdefghijklmnop12345 leaked')).toBe('token phs_[REDACTED] leaked');
    expect(redact('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('{"authorization":"Bearer xyz"}')).toBe('{"authorization":"Bearer [REDACTED]"}');
  });

  it('recognizes keys pasted as arguments', () => {
    expect(looksLikeCredential(KEY)).toBe(true);
    expect(looksLikeCredential(`--whatever=${KEY}`)).toBe(true);
    expect(looksLikeCredential('phx_report.html')).toBe(false);
    expect(looksLikeCredential('report.html')).toBe(false);
  });
});

describe('--host', () => {
  it('maps ingestion hosts to the API host and keeps self-hosted origins', () => {
    expect(normalizeHost('us.i.posthog.com').origin).toBe('https://us.posthog.com');
    expect(normalizeHost('https://eu.i.posthog.com').origin).toBe('https://eu.posthog.com');
    expect(normalizeHost('https://app.posthog.com').origin).toBe('https://us.posthog.com');
    expect(normalizeHost('https://eu.posthog.com/').origin).toBe('https://eu.posthog.com');
    expect(normalizeHost('posthog.acme.internal').origin).toBe('https://posthog.acme.internal');
    expect(normalizeHost('http://localhost:8000').origin).toBe('http://localhost:8000');
  });

  it('refuses plain http, credentials and paths', () => {
    expect(() => normalizeHost('http://posthog.acme.example')).toThrow(/plain HTTP/);
    expect(normalizeHost('http://posthog.acme.example', { allowHttp: true }).origin).toBe('http://posthog.acme.example');
    expect(() => normalizeHost('https://user:pass@us.posthog.com')).toThrow(/credentials/);
    expect(() => normalizeHost('https://us.posthog.com/project/1')).toThrow(/just the origin/);
    expect(() => normalizeHost('https://us.posthog.com/?x=1')).toThrow(/query string/);
    expect(() => normalizeHost('')).toThrow(UsageError);
  });
});


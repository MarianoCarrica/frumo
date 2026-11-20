import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELP } from '../src/args.js';
import { main } from '../src/cli.js';
import type { CliIo } from '../src/cli.js';
import { tieredCost } from '../src/pricing/math.js';
import { SENTRY_PUBLIC_PRICING } from '../src/pricing/public-pricing.js';
import type { SentryBilledCategory, SentryPlan } from '../src/pricing/types.js';
import { applyEffects, categoryCost, runSentryAnalysis } from '../src/sentry/analysis.js';
import { SENTRY_HELP, parseSentryArgs, readSentryDemoSnapshot } from '../src/sentry/cli.js';
import { SentryReadOnlyClient, assertSentryReadOnly, nextLink } from '../src/sentry/client.js';
import { collectSentrySnapshot } from '../src/sentry/collect.js';
import type { SentryAuditResult } from '../src/sentry/model.js';
import { renderSentryJson, renderSentryTerminal } from '../src/sentry/report.js';
import { beforeSendSnippet, ignoreErrorsSnippet } from '../src/sentry/snippets.js';
import { SENTRY_SNAPSHOT_SCHEMA, parseSentrySnapshot } from '../src/sentry/snapshot.js';
import type { SentrySnapshot } from '../src/sentry/snapshot.js';
import { ReadOnlyViolation } from '../src/util/errors.js';
import { Secret, looksLikeCredential, redact } from '../src/util/secret.js';
import { ValidationError } from '../src/util/validate.js';
import { KEY_SECRETS, ORG, SENTRY_TOKEN, fakeSentry } from './fake-sentry.js';
import { NOW, evaluate, json, mockFetch, noSleep } from './helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'frumo-sentry-test-'));
const cost = (category: SentryBilledCategory, units: number, plan: SentryPlan = 'team'): number =>
  tieredCost(units, SENTRY_PUBLIC_PRICING.categories[category].tiers[plan]);

function io(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    stdoutIsTTY: false,
    now: NOW,
    sleep: noSleep,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

function analyze(snap: SentrySnapshot, plan: SentryPlan = 'team'): SentryAuditResult {
  return runSentryAnalysis(snap, { toolVersion: 'test', plan, now: NOW });
}

function minimal(overrides: Partial<SentrySnapshot> = {}): SentrySnapshot {
  return {
    schema: SENTRY_SNAPSHOT_SCHEMA,
    generatedAt: NOW.toISOString(),
    source: { kind: 'file', host: null, toolVersion: 'test', fictional: false, label: null },
    org: { slug: 'acme', name: null },
    period: { days: 30, start: null, end: null },
    stats: [],
    statsMissing: [],
    projects: [],
    issues: [],
    projectConfigs: [],
    notes: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sentry PAYG pricing (published bands, included volume first)', () => {
  it('charges nothing inside the included volume', () => {
    expect(cost('errors', 50_000)).toBe(0);
    expect(cost('spans', 5_000_000)).toBe(0);
    expect(cost('replays', 50)).toBe(0);
    expect(cost('attachments', 1)).toBe(0);
  });

  it('prices errors across the included 50K and each band (Team)', () => {
    expect(cost('errors', 50_001)).toBeCloseTo(0.0003625, 10);
    expect(cost('errors', 100_000)).toBeCloseTo(18.125, 6);
    expect(cost('errors', 500_000)).toBeCloseTo(18.125 + 87.52, 6);
    expect(cost('errors', 10_000_000)).toBeCloseTo(18.125 + 87.52 + 1781.25, 6);
    expect(cost('errors', 20_000_000)).toBeCloseTo(18.125 + 87.52 + 1781.25 + 1625, 6);
    expect(cost('errors', 30_000_000)).toBeCloseTo(18.125 + 87.52 + 1781.25 + 1625 + 1500, 6);
  });

  it('prices Business errors and spans higher than Team, and replays/attachments the same', () => {
    expect(cost('errors', 100_000, 'business')).toBeCloseTo(55.625, 6);
    expect(cost('errors', 500_000, 'business')).toBeCloseTo(55.625 + 250, 6);
    expect(cost('spans', 10_000_000, 'team')).toBeCloseTo(10, 6);
    expect(cost('spans', 10_000_000, 'business')).toBeCloseTo(20, 6);
    expect(cost('replays', 5_050, 'team')).toBeCloseTo(cost('replays', 5_050, 'business'), 10);
    expect(cost('attachments', 3, 'team')).toBe(cost('attachments', 3, 'business'));
  });

  it('prices spans past 100M, replays across bands, and attachments per GB', () => {
    expect(cost('spans', 200_000_000)).toBeCloseTo(95_000_000 * 0.000002 + 100_000_000 * 0.0000018, 6);
    expect(cost('replays', 5_050)).toBeCloseTo(4_950 * 0.00375 + 50 * 0.003563, 6);
    expect(cost('replays', 100_000)).toBeCloseTo(4_950 * 0.00375 + 95_000 * 0.003563, 6);
    expect(cost('attachments', 3)).toBeCloseTo(0.625, 6);
    expect(categoryCost('attachments', 3, 'team')).toBeCloseTo(0.625, 6);
  });

  it('records the sources and the date the prices were checked', () => {
    expect(SENTRY_PUBLIC_PRICING.retrieved).toBe('2026-11-20');
    expect(SENTRY_PUBLIC_PRICING.sources).toEqual(['https://docs.sentry.io/pricing/', 'https://sentry.io/pricing/']);
    for (const c of ['errors', 'spans', 'replays', 'attachments'] as const) {
      for (const plan of ['team', 'business'] as const) {
        const tiers = SENTRY_PUBLIC_PRICING.categories[c].tiers[plan];
        expect(tiers[0]).toEqual({ upTo: SENTRY_PUBLIC_PRICING.categories[c].included, unitUsd: 0 });
        expect(tiers[tiers.length - 1]?.upTo).toBeNull();
      }
    }
  });

  it('applies absolute removals before fractions', () => {
    const after = applyEffects({ errors: 1_000, spans: 100, replays: null, attachments: 0 }, [
      { category: 'errors', removeFraction: 0.5 },
      { category: 'errors', removeUnits: 200 },
      { category: 'replays', removeUnits: 5 },
    ]);
    expect(after).toEqual({ errors: 400, spans: 100, replays: null, attachments: 0 });
  });
});

describe('Sentry demo fixture and analyzers', () => {
  it('is fictional, has uneven projects, mixed outcomes, an ignored noisy issue and no DSNs', async () => {
    const snap = await readSentryDemoSnapshot();
    expect(snap.source.fictional).toBe(true);
    expect(snap.projects?.length).toBeGreaterThanOrEqual(4);
    expect(new Set(snap.stats?.map((s) => s.outcome))).toEqual(new Set(['accepted', 'filtered', 'rate_limited', 'client_discard']));
    expect(snap.issues?.some((i) => i.status === 'ignored' && i.count >= 100_000)).toBe(true);
    expect(snap.projectConfigs.some((c) => c.keys?.some((k) => k.rateLimit === null))).toBe(true);
    const raw = readFileSync(join(__dirname, '..', 'fixtures', 'sentry-demo-snapshot.json'), 'utf8');
    expect(raw).not.toMatch(/ingest|"dsn"|"secret"|"public"|sentry_key/i);
  });

  it('produces a non-zero Team bill and non-zero savings', async () => {
    const result = analyze(await readSentryDemoSnapshot());
    expect(result.costs.totalUsd).toBeGreaterThan(0);
    expect(result.savings.noRegretUsd).toBeGreaterThan(0);
    expect(result.savings.allUsd).toBeGreaterThanOrEqual(result.savings.noRegretUsd);
    expect(result.savings.allUsd).toBeLessThan(result.costs.totalUsd);
    const errors = result.costs.lines.find((l) => l.category === 'errors');
    expect(errors?.accepted).toBe(2_350_000);
    expect(errors?.usd).toBeCloseTo(cost('errors', 2_350_000), 6);
    // Attachments are bytes in stats_v2 and billed per GB.
    expect(result.costs.lines.find((l) => l.category === 'attachments')?.accepted).toBeCloseTo(3.7, 6);
  });

  it('recommends dropping ignored issues that still bill, as a no-regret fix with snippets', async () => {
    const result = analyze(await readSentryDemoSnapshot());
    const fix = result.fixes.find((f) => f.id === 'drop-ignored-issues');
    expect(fix?.kind).toBe('no-regret');
    expect(fix?.savingUsd).toBeCloseTo(cost('errors', 2_350_000) - cost('errors', 2_350_000 - 775_000), 6);
    expect(fix?.evidence).toMatch(/still count toward your quota/);
    const code = fix?.snippets.map((s) => s.code).join('\n') ?? '';
    expect(code).toContain('ignoreErrors');
    expect(code).toContain('beforeSend');
    expect(code).toContain('ResizeObserver loop completed with undelivered notifications');
    expect(code).toContain("dsn: '<sentry_dsn>'");
    const row = result.issues.find((i) => i.title.startsWith('ResizeObserver'));
    expect(row?.ignoredButBilled).toBe(true);
    expect(row?.fixId).toBe('drop-ignored-issues');
  });

  it('recommends turning on an inactive browser-extensions filter, and only for browser projects', async () => {
    const result = analyze(await readSentryDemoSnapshot());
    const web = result.fixes.find((f) => f.id === 'inbound-filters:web-app');
    expect(web?.kind).toBe('no-regret');
    expect(web?.steps[0]).toMatch(/browser-extensions/);
    expect(web?.savingUsd).toBeGreaterThan(0); // the chrome-extension:// issue is attributed to it
    const api = result.fixes.find((f) => f.id === 'inbound-filters:api');
    expect(api?.steps[0]).not.toMatch(/browser-extensions|web-crawlers/); // a Node project
    expect(api?.steps[0]).toMatch(/filtered-transaction/);
    expect(api?.savingUsd).toBeNull();
  });

  it('does not tell a Team-plan user to use custom inbound filters, Delete & Discard or DSN rate limits', async () => {
    const result = analyze(await readSentryDemoSnapshot(), 'team');
    expect(result.fixes.map((f) => f.id)).not.toContain('key-rate-limits');
    const advice = result.fixes.flatMap((f) => [...f.steps, f.evidence, f.assumption]).join('\n');
    expect(advice).not.toMatch(/you can (also )?(add custom|stop them server-side|Delete)/i);
    expect(advice).toMatch(/Business\/Enterprise \(and Trial\) only/);
    const rateNote = result.findings.find((f) => /rate limit/.test(f.text));
    expect(rateNote?.text).toMatch(/Business\/Enterprise only/);
    expect(result.findings.some((f) => /not replays/.test(f.text) && /Settings > Spike Protection/.test(f.text))).toBe(true);
  });

  it('on Business, offers per-key rate limits and server-side options', async () => {
    const result = analyze(await readSentryDemoSnapshot(), 'business');
    expect(result.fixes.map((f) => f.id)).toContain('key-rate-limits');
    expect(result.fixes.find((f) => f.id === 'drop-ignored-issues')?.steps.join(' ')).toMatch(/Delete & Discard/);
    expect(result.costs.totalUsd).toBeGreaterThan(analyze(await readSentryDemoSnapshot(), 'team').costs.totalUsd);
  });

  it('suggests sampling only when the volume justifies it', () => {
    const small = analyze(
      minimal({
        projects: [{ id: '1', slug: 'web', name: null, platform: 'javascript' }],
        stats: [
          { projectId: '1', category: 'error', outcome: 'accepted', quantity: 60_000 },
          { projectId: '1', category: 'transaction', outcome: 'accepted', quantity: 6_000_000 },
        ],
      }),
    );
    expect(small.fixes.map((f) => f.id)).not.toContain('traces-sample-rate');
    expect(small.fixes.map((f) => f.id)).not.toContain('error-sample-rate');
    const big = analyze(
      minimal({
        projects: [{ id: '1', slug: 'web', name: null, platform: 'javascript' }],
        stats: [
          { projectId: '1', category: 'error', outcome: 'accepted', quantity: 8_000_000 },
          { projectId: '1', category: 'transaction', outcome: 'accepted', quantity: 80_000_000 },
        ],
      }),
    );
    const traces = big.fixes.find((f) => f.id === 'traces-sample-rate');
    expect(traces?.kind).toBe('trade-off');
    expect(traces?.snippets[0]?.code).toMatch(/tracesSampleRate: 0\.1/);
    expect(traces?.snippets[0]?.code).toMatch(/hides some traces/);
    expect(big.fixes.find((f) => f.id === 'error-sample-rate')?.snippets[0]?.code).toMatch(/sampleRate: 0\.5/);
  });

  it('reports no bill (not $0) when stats are missing', () => {
    const result = analyze(minimal({ stats: null }));
    expect(result.costs.anyKnown).toBe(false);
    expect(renderSentryTerminal(result, { color: false })).toMatch(/Total \(pay-as-you-go above included volume\)\s+n\/a/);
  });

  it('validates snapshots and drops unknown fields such as DSNs', () => {
    const snap = parseSentrySnapshot({
      ...minimal(),
      projectConfigs: [{ projectSlug: 'web', filters: [], keys: [{ label: 'Default', dsn: { secret: KEY_SECRETS.dsnSecret }, secret: KEY_SECRETS.secretKey, rateLimit: null }] }],
    });
    expect(JSON.stringify(snap)).not.toContain(KEY_SECRETS.secretKey);
    expect(snap.projectConfigs[0]?.keys).toEqual([{ label: 'Default', isActive: true, rateLimit: null }]);
    expect(() => parseSentrySnapshot({ schema: 'nope', org: {}, period: { days: 0 } })).toThrow(ValidationError);
  });
});

describe('Sentry snippets', () => {
  const targets = [
    { match: "TypeError: Cannot read properties of null (reading 'x')", note: 'web · ignored · 1K/mo' },
    { match: 'Script error.\nInjected', note: 'line\nbreak' },
  ];

  it('produce valid JavaScript whose beforeSend drops exactly the listed errors', () => {
    let options: { beforeSend: (e: unknown) => unknown; dsn: string } | null = null;
    const Sentry = { init: (o: typeof options) => (options = o) };
    evaluate(beforeSendSnippet(targets).code, { Sentry });
    expect(options).not.toBeNull();
    const o = options as unknown as { beforeSend: (e: unknown) => unknown; dsn: string };
    expect(o.dsn).toBe('<sentry_dsn>');
    const noisy = { exception: { values: [{ type: 'TypeError', value: "Cannot read properties of null (reading 'x')" }] } };
    const real = { exception: { values: [{ type: 'Error', value: 'checkout failed' }] } };
    expect(o.beforeSend(noisy)).toBeNull();
    expect(o.beforeSend(real)).toBe(real);
    expect(o.beforeSend({ message: 'Script error. Injected' })).toBeNull();
  });

  it('escape quotes and newlines in ignoreErrors', () => {
    let options: { ignoreErrors: string[] } | null = null;
    evaluate(ignoreErrorsSnippet(targets).code, { Sentry: { init: (o: typeof options) => (options = o) } });
    expect((options as unknown as { ignoreErrors: string[] }).ignoreErrors).toEqual(["TypeError: Cannot read properties of null (reading 'x')", 'Script error. Injected']);
  });
});

describe('Sentry read-only client', () => {
  it('sends only GETs under /api/0/ with the token in the Authorization header, and never follows redirects', async () => {
    const mock = mockFetch(() => json([]));
    const c = new SentryReadOnlyClient({ origin: 'https://sentry.io', token: new Secret(SENTRY_TOKEN), toolVersion: 'test', fetchImpl: mock.fetch, minIntervalMs: 0 });
    await c.get('/api/0/organizations/acme/stats_v2/', { groupBy: ['project', 'outcome'], category: 'error' });
    const call = mock.calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url.searchParams.getAll('groupBy')).toEqual(['project', 'outcome']);
    expect(call?.headers.authorization).toBe(`Bearer ${SENTRY_TOKEN}`);
    expect(call?.redirect).toBe('manual');
    await expect(c.get('/api/1/x/')).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(c.getNext('https://evil.example/api/0/organizations/acme/issues/?cursor=1')).rejects.toThrow(/another host/);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => assertSentryReadOnly(method, new URL('https://sentry.io/api/0/projects/a/b/filters/browser-extensions/'), undefined)).toThrow(ReadOnlyViolation);
    }
    expect(mock.calls).toHaveLength(1);
  });

  it('reads the next page from the Link header only when Sentry says there are results', () => {
    const base = 'https://sentry.io/api/0/organizations/acme/issues/';
    expect(nextLink(`<${base}?cursor=a>; rel="previous"; results="false"; cursor="a", <${base}?cursor=b>; rel="next"; results="true"; cursor="b"`)).toBe(`${base}?cursor=b`);
    expect(nextLink(`<${base}?cursor=b>; rel="next"; results="false"; cursor="b"`)).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it('redacts Sentry tokens and refuses them as arguments', () => {
    expect(redact(`token ${SENTRY_TOKEN} here`)).not.toContain(SENTRY_TOKEN);
    expect(looksLikeCredential(SENTRY_TOKEN)).toBe(true);
    expect(() => parseSentryArgs(['--org', 'acme', '--auth-token', 'x'])).toThrow(/SENTRY_AUTH_TOKEN/);
    expect(() => parseSentryArgs(['--org', 'acme', SENTRY_TOKEN])).toThrow(/SENTRY_AUTH_TOKEN/);
  });
});

describe('Sentry live collection (mocked fetch, no network)', () => {
  it('collects a snapshot from GETs only and keeps no DSN, key id or secret', async () => {
    const fake = fakeSentry();
    const client = new SentryReadOnlyClient({ origin: 'https://sentry.io', token: new Secret(SENTRY_TOKEN), toolVersion: 'test', fetchImpl: fake.fetch, minIntervalMs: 0, sleep: noSleep });
    const snap = await collectSentrySnapshot(client, { org: ORG, days: 30, toolVersion: 'test', now: NOW });
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    const paths = fake.calls.map((c) => c.url.pathname);
    expect(paths.filter((p) => p.endsWith('/stats_v2/'))).toHaveLength(4);
    expect(paths).toContain(`/api/0/projects/${ORG}/storefront/keys/`);
    const issues = fake.calls.find((c) => c.url.pathname.endsWith('/issues/'));
    expect(issues?.url.searchParams.get('query')).toBe('');
    expect(issues?.url.searchParams.get('sort')).toBe('freq');
    expect(snap.stats?.length).toBe(6);
    expect(snap.issues?.[0]).toMatchObject({ title: 'ResizeObserver loop limit exceeded', count: 300_000, status: 'ignored', projectSlug: 'storefront' });
    expect(snap.projectConfigs.find((c) => c.projectSlug === 'storefront')?.keys).toEqual([{ label: 'Default', isActive: true, rateLimit: null }]);
    expect(snap.projectConfigs.find((c) => c.projectSlug === 'orders-api')?.keys?.[0]?.rateLimit).toEqual({ window: 60, count: 500 });
    expect(snap.projectConfigs.find((c) => c.projectSlug === 'storefront')?.filters).toContainEqual({ id: 'legacy-browsers', active: true });

    const text = [JSON.stringify(snap), renderSentryJson(analyze(snap)), renderSentryTerminal(analyze(snap), { color: false, full: true })].join('\n');
    for (const secret of [...Object.values(KEY_SECRETS), SENTRY_TOKEN]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/ingest\.fernhollow|sentry_key/);
  });

  it('runs `frumo sentry --org` end to end without exposing the token or DSNs, and saves a reusable snapshot', async () => {
    const fake = fakeSentry();
    const file = join(dir, 'sentry-snapshot.json');
    const t = io({ SENTRY_AUTH_TOKEN: SENTRY_TOKEN }, fake.fetch);
    expect(await main(['sentry', '--org', ORG, '--verbose', '--save-snapshot', file], t.io)).toBe(0);
    const out = t.out();
    expect(out).toContain('Live, read-only: https://sentry.io');
    expect(out).toContain('ResizeObserver loop limit exceeded');
    expect(out).toContain('Turn on built-in inbound filters in storefront');
    expect(out).toMatch(/Total \(pay-as-you-go above included volume\)\s+\$221/);
    const saved = readFileSync(file, 'utf8');
    for (const text of [out, t.err(), saved]) {
      for (const secret of [...Object.values(KEY_SECRETS), SENTRY_TOKEN]) expect(text).not.toContain(secret);
    }
    expect(t.err()).toContain('GET /api/0/organizations/fernhollow/stats_v2/ → 200');

    const again = io();
    expect(await main(['sentry', '--from', file, '--json'], again.io)).toBe(0);
    expect((JSON.parse(again.out()) as SentryAuditResult).costs.totalUsd).toBeCloseTo(cost('errors', 1_000_000) + cost('spans', 12_000_000) + cost('replays', 2_000), 6);
  });

  it('stops on a rejected token, names the variable, and never prints the token', async () => {
    const t = io({ SENTRY_AUTH_TOKEN: SENTRY_TOKEN }, fakeSentry({ failAll: 401 }).fetch);
    expect(await main(['sentry', '--org', ORG], t.io)).toBe(1);
    expect(t.err()).toMatch(/401: Sentry rejected the token in SENTRY_AUTH_TOKEN/);
    expect(t.err() + t.out()).not.toContain(SENTRY_TOKEN);
  });

  it('explains how to provide the token, with the read-only scopes', async () => {
    const t = io();
    expect(await main(['sentry', '--org', ORG], t.io)).toBe(2);
    expect(t.err()).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(t.err()).toMatch(/org:read, project:read, event:read/);
  });
});

describe('frumo sentry CLI', () => {
  it('runs the demo: exit 0, unofficial/estimate wording, dollars, an issue name and a snippet, with no network', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('frumo sentry demo must not use the network')));
    vi.stubGlobal('fetch', fetchSpy);
    const t = io({}, fetchSpy);
    expect(await main(['sentry', 'demo'], t.io)).toBe(0);
    const text = t.out();
    expect(text).toContain('unofficial, not affiliated with Functional Software, Inc. (Sentry)');
    expect(text).toContain('estimate from public list prices, not your invoice');
    expect(text).toMatch(/not affiliated with or endorsed by Functional Software, Inc\./);
    expect(text).toMatch(/Total \(pay-as-you-go above included volume\)\s+\$611/);
    expect(text).toMatch(/POTENTIAL SAVING\s+\$\d+/);
    expect(text).toContain('ResizeObserver loop completed with undelivered notifications');
    expect(text).toMatch(/ignoreErrors|beforeSend/);
    expect(text).toContain('Demo data: a fictional organization');
    expect(text.trimEnd().endsWith('Found this useful? Join the frumo waitlist: https://frumo.marianoventures.com/?ref=cli')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prints JSON without the waitlist line, and honours --no-footer and --plan', async () => {
    const j = io();
    expect(await main(['sentry', 'demo', '--json', '--plan', 'business'], j.io)).toBe(0);
    const result = JSON.parse(j.out()) as SentryAuditResult;
    expect(result.schema).toBe('frumo.sentry-report/v1');
    expect(result.input.plan).toBe('business');
    expect(j.out()).not.toContain('waitlist');
    const n = io();
    expect(await main(['sentry', 'demo', '--no-footer'], n.io)).toBe(0);
    expect(n.out()).not.toContain('waitlist');
  });

  it('documents itself in --help, and frumo --help mentions it with the token scopes', async () => {
    const h = io();
    expect(await main(['sentry', '--help'], h.io)).toBe(0);
    expect(h.out()).toBe(SENTRY_HELP);
    expect(SENTRY_HELP).toContain('frumo sentry demo');
    expect(SENTRY_HELP).toContain('Scopes: org:read, project:read, event:read');
    expect(HELP).toContain('frumo sentry demo');
    expect(HELP).toContain('Scopes: org:read, project:read, event:read');
    expect(HELP).toMatch(/^frumo: find what drives your PostHog bill/);
  });

  it('fails cleanly on bad input', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['sentry'], /Nothing to audit/],
      [['sentry', 'demo', '--plan', 'enterprise'], /--plan must be one of: team, business/],
      [['sentry', 'demo', '--days', '91'], /--days must be between 1 and 90/],
      [['sentry', 'demo', '--html', 'x.html'], /--html is not available/],
      [['sentry', '--org', 'bad slug!'], /--org must be the organization slug/],
      [['sentry', 'demo', '--host', 'http://sentry.example'], /https/],
      [['--quiet', 'sentry'], /Put "sentry" first/],
    ];
    for (const [argv, message] of cases) {
      const t = io();
      expect(await main(argv, t.io), argv.join(' ')).toBe(2);
      expect(t.err()).toMatch(message);
    }
  });
});

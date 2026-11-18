import { describe, expect, it } from 'vitest';
import { costBreakdown } from '../src/analysis/costs.js';
import { runAnalysis } from '../src/analysis/index.js';
import { publicPricing } from '../src/pricing/override.js';
import { visibleBillLines } from '../src/report/format.js';
import { parseSnapshot } from '../src/snapshot.js';
import { PostHogReadOnlyClient } from '../src/sources/live/client.js';
import { collectSnapshot, parseBillingUsage } from '../src/sources/live/collect.js';
import { buildQueries } from '../src/sources/live/queries.js';
import { ApiError } from '../src/util/errors.js';
import { Secret } from '../src/util/secret.js';
import { PROJECT, STAGING, fakePostHog } from './fake-posthog.js';
import type { FakeOptions } from './fake-posthog.js';
import { NOW, noSleep, usage } from './helpers.js';

const KEY = 'phx_LIVEKEY0123456789abcdefghijklmnopqrstuv';

async function collect(options: FakeOptions = {}) {
  const fake = fakePostHog(options);
  const client = new PostHogReadOnlyClient({ origin: 'https://us.posthog.com', apiKey: new Secret(KEY), toolVersion: 'test', fetchImpl: fake.fetch, sleep: noSleep, minIntervalMs: 0 });
  const progress: string[] = [];
  const snap = await collectSnapshot(client, { projectId: PROJECT, days: 30, toolVersion: 'test', now: NOW, progress: (l) => progress.push(l) });
  return { snap, calls: fake.calls, progress };
}

describe('live collection (fake PostHog, no network)', () => {
  it('only issues GETs and registered HogQL SELECTs', async () => {
    const { calls } = await collect();
    const sql = new Set(buildQueries(30).map((q) => q.sql));
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) {
      expect(call.url.origin).toBe('https://us.posthog.com');
      expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(call.url.toString()).not.toContain(KEY);
      if (call.method === 'GET') continue;
      expect(call.method).toBe('POST');
      expect(call.url.pathname).toBe(`/api/projects/${PROJECT}/query/`);
      const body = JSON.parse(call.body ?? '{}') as { query: { kind: string; query: string } };
      expect(body.query.kind).toBe('HogQLQuery');
      expect(sql.has(body.query.query)).toBe(true);
    }
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(buildQueries(30).length);
  });

  it('maps every endpoint into the snapshot format', async () => {
    const { snap } = await collect();
    expect(() => parseSnapshot(JSON.parse(JSON.stringify(snap)))).not.toThrow();
    expect(snap.source).toMatchObject({ kind: 'live', host: 'https://us.posthog.com', fictional: false });
    expect(snap.project).toEqual({ id: PROJECT, name: 'Acme Production' });
    expect(snap.projectSettings?.sessionRecordingSampleRate).toBe(1);
    expect(snap.projectSettings?.sessionRecordingTriggerGroupCount).toBe(0);

    const prod = snap.orgUsage?.find((p) => p.projectId === PROJECT);
    const staging = snap.orgUsage?.find((p) => p.projectId === STAGING);
    expect(prod).toMatchObject({ audited: true, name: 'Acme Production' });
    expect(prod?.usage).toMatchObject({ events: 3_000_000, identifiedEvents: 1_500_000, recordings: 30_000, flagRequests: 4_000_000 });
    expect(staging).toMatchObject({ audited: false, name: 'Acme Staging' });
    expect(staging?.usage).toMatchObject({ events: 800_000, flagRequests: 1_000_000 });

    expect(snap.billing?.limitsUsd).toEqual({ product_analytics: 500, session_replay: null });
    expect(snap.billing?.projectedTotalUsd).toBe(812.5);
    expect(Object.keys(snap.billing?.pricing?.products ?? {})).toEqual(['product_analytics', 'identified_events']);
    expect(snap.notes.join(' ')).toMatch(/Ignored the billing plan tiers for feature_flags/);

    expect(snap.flags?.definitions?.map((f) => f.key)).toEqual(['new-billing', 'sso', 'old-flag']);
    expect(snap.flags?.definitions?.[1]?.usesIsNotSet).toBe(true);
    expect(snap.flags?.calledByLib?.[0]).toEqual({ lib: 'posthog-node', locallyEvaluated: 'false', count: 200_000, flags: 4 });
    expect(snap.events?.totals).toEqual({ all: 3_300_000, billable: 3_000_000, billableIdentified: 1_500_000, unidentifiedPersonEvents: 400_000 });
    expect(snap.events?.autocaptureElements?.[1]?.classes).toBeNull();
    expect(snap.replay?.byFirstUrl?.[0]?.singleUrl).toBe(10_000);
    expect(JSON.stringify(snap)).not.toContain(KEY);
  });

  it('produces a full audit priced with the organization’s own plan where available', async () => {
    const { snap } = await collect();
    const result = runAnalysis(snap, { toolVersion: 'test', now: NOW });
    expect(result.input.scope).toBe('organization');
    expect(result.pricing.sources.product_analytics).toBe('billing-api');
    expect(result.pricing.sources.session_replay).toBe('public');
    expect(result.costs.totalUsd).toBeGreaterThan(0);
    expect(result.fixes.map((f) => f.id)).toEqual(expect.arrayContaining(['flags-local-evaluation', 'person-profiles-identified-only', 'staging-project-456']));
    expect(result.billingLimits.find((b) => b.product === 'product_analytics')?.existingLimitUsd).toBe(500);
  });

  it('keeps going without optional scopes and records what was skipped', async () => {
    const { snap, progress } = await collect({ failPaths: { '/api/billing/': 403, '/api/billing/usage/': 403, [`/api/projects/${PROJECT}/feature_flags/`]: 403 }, failQueries: ['hogpost_replay_first_urls'] });
    expect(snap.orgUsage).toBeNull();
    expect(snap.billing).toBeNull();
    expect(snap.flags?.definitions).toBeNull();
    expect(snap.replay?.byFirstUrl).toBeNull();
    const notes = snap.notes.join('\n');
    expect(notes).toMatch(/billing:read scope/);
    expect(notes).toMatch(/feature_flag:read scope/);
    expect(notes).toMatch(/replay_first_urls/);
    expect(progress.join('\n')).toMatch(/✗ organization usage by project/);
    const result = runAnalysis(snap, { toolVersion: 'test', now: NOW });
    expect(result.input.scope).toBe('project');
    expect(result.notAnalyzed.join(' ')).toMatch(/Feature flag requests/);
  });

  it('stops immediately on an invalid key', async () => {
    await expect(collect({ failPaths: { [`/api/projects/${PROJECT}/`]: 401 } })).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.isAuthFailure);
  });

  it('stops when the first HogQL query fails (nothing to analyze)', async () => {
    await expect(collect({ failQueries: ['hogpost_totals'] })).rejects.toThrow(/query:read/);
  });
});

describe('billing usage parsing', () => {
  it('accepts string breakdown values and falls back to the audited project without a team', () => {
    const notes: string[] = [];
    const rows = parseBillingUsage(
      {
        results: [
          { label: 'x', data: [5, 5], breakdown_value: 'recording_count_in_period::77' },
          { label: 'event_count_in_period', data: [3], breakdown_type: 'type', breakdown_value: 'event_count_in_period' },
          { label: 'mobile', data: [4], breakdown_value: ['mobile_recording_count_in_period', 1] },
          { label: 'mobile billable', data: [2], breakdown_value: ['mobile_billable_recording_count_in_period', 1] },
        ],
      },
      '1',
      notes,
    );
    expect(rows?.find((r) => r.projectId === '77')?.usage.recordings).toBe(10);
    expect(rows?.find((r) => r.projectId === '1')?.usage.events).toBe(3);
    expect(rows?.find((r) => r.projectId === '1')?.usage.mobileRecordings).toBe(2);
    expect(parseBillingUsage({ unexpected: true }, '1', notes)).toBeNull();
    expect(notes[0]).toMatch(/unexpected shape/);
  });

  it('treats a meter reported for one project as zero for the others, and never-reported meters as unknown', () => {
    const rows = parseBillingUsage(
      {
        results: [
          { data: [10], breakdown_value: ['event_count_in_period', 1] },
          { data: [5], breakdown_value: ['event_count_in_period', 2] },
          { data: [7], breakdown_value: ['billable_feature_flag_requests_count_in_period', 2] },
        ],
      },
      '1',
      [],
    );
    const audited = rows?.find((r) => r.projectId === '1')?.usage;
    expect(audited?.flagRequests).toBe(0);
    expect(audited?.events).toBe(10);
    expect(audited?.mobileRecordings).toBeNull();
  });
});

describe('bill lines', () => {
  it('omits optional meters with unknown usage but flags unknown core meters', () => {
    const lines = visibleBillLines(costBreakdown(usage({ events: 5_000_000, mobileRecordings: null, flagRequests: null }), publicPricing()).lines);
    expect(lines.map((l) => l.usageKey)).toEqual(['events', 'identifiedEvents', 'recordings', 'flagRequests']);
    expect(lines.filter((l) => l.missing === 'usage-unknown').map((l) => l.usageKey)).toEqual(['identifiedEvents', 'recordings', 'flagRequests']);
  });
});

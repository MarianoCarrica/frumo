/**
 * Live mode: collects a Snapshot from a PostHog instance with read-only calls.
 *
 * Calls (all optional except the HogQL totals query):
 *   GET  /api/projects/:id/                  project:read        replay/autocapture settings, name
 *   GET  /api/billing/                        billing:read        plan tiers, discount, billing limits
 *   GET  /api/billing/usage/                  billing:read        per-project usage (events, recordings, flag requests…)
 *   GET  /api/organizations/@current/projects/ project:read       project names for the usage breakdown
 *   GET  /api/projects/:id/feature_flags/      feature_flag:read   active flags
 *   POST /api/projects/:id/query/             query:read          13 hard-coded HogQL SELECTs (see queries.ts)
 */
import { isProductKey } from '../../pricing/types.js';
import type { ProductKey } from '../../pricing/types.js';
import type { PricingOverride, ProductOverride } from '../../pricing/override.js';
import { parseTier } from '../../pricing/override.js';
import { tierProblems } from '../../pricing/math.js';
import { SNAPSHOT_SCHEMA, emptyUsage } from '../../snapshot.js';
import type {
  BillingInfo,
  EventsData,
  FlagDefinition,
  FlagsData,
  ProjectSettings,
  ProjectUsage,
  ReplayData,
  Snapshot,
  Usage,
  UsageKey,
} from '../../snapshot.js';
import { ApiError } from '../../util/errors.js';
import { Issues, isRecord } from '../../util/validate.js';
import type { PostHogReadOnlyClient } from './client.js';
import { buildQueries } from './queries.js';
import type { HogQLQuery, QueryId } from './queries.js';

export interface CollectOptions {
  projectId: string;
  days: number;
  toolVersion: string;
  now?: Date;
  /** Progress lines (stderr). */
  progress?: (line: string) => void;
}

/** Billing usage types → HogPost meters. Order matters: the billable mobile count wins over the raw one. */
const USAGE_TYPE_TO_KEY: ReadonlyArray<[string, UsageKey]> = [
  ['event_count_in_period', 'events'],
  ['enhanced_persons_event_count_in_period', 'identifiedEvents'],
  ['recording_count_in_period', 'recordings'],
  ['mobile_billable_recording_count_in_period', 'mobileRecordings'],
  ['mobile_recording_count_in_period', 'mobileRecordings'],
  ['billable_feature_flag_requests_count_in_period', 'flagRequests'],
  ['survey_responses_count_in_period', 'surveyResponses'],
  ['exceptions_captured_in_period', 'exceptions'],
];

/** PostHog billing product types → HogPost price lists. */
const BILLING_TYPE_TO_PRODUCT: Record<string, ProductKey> = {
  product_analytics: 'product_analytics',
  enhanced_persons: 'identified_events',
  session_replay: 'session_replay',
  mobile_replay: 'mobile_replay',
  feature_flags: 'feature_flags',
  surveys: 'surveys',
  error_tracking: 'error_tracking',
};

export async function collectSnapshot(client: PostHogReadOnlyClient, options: CollectOptions): Promise<Snapshot> {
  const progress = options.progress ?? (() => undefined);
  const notes: string[] = [];
  const now = options.now ?? new Date();
  const { projectId, days } = options;
  const queries = buildQueries(days);

  /** Runs an optional step; auth failures abort, everything else becomes a note. */
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await fn();
      progress(`  ✓ ${label}`);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) throw error;
      const message = error instanceof Error ? error.message : String(error);
      progress(`  ✗ ${label}: ${message}`);
      notes.push(`${label} unavailable: ${message}`);
      return null;
    }
  };

  progress(`Collecting read-only data from ${client.origin} (project ${projectId}, last ${days} days)…`);

  const projectRaw = await step('project settings', async () => {
    try {
      return await client.get<Record<string, unknown>>(`/api/projects/${projectId}/`, {}, { scope: 'project:read' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return client.get<Record<string, unknown>>(`/api/organizations/@current/projects/${projectId}/`, {}, { scope: 'project:read' });
      }
      throw error;
    }
  });
  const projectSettings = projectRaw ? parseProjectSettings(projectRaw) : null;
  const projectName = projectRaw && typeof projectRaw.name === 'string' ? projectRaw.name : null;

  const billingRaw = await step('billing plan (prices, limits)', () => client.get<unknown>('/api/billing/', {}, { scope: 'billing:read' }));
  const billing = billingRaw ? parseBillingOverview(billingRaw, notes) : null;

  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const usageRaw = await step('organization usage by project', () =>
    client.get<unknown>(
      '/api/billing/usage/',
      {
        start_date: isoDate(start),
        end_date: isoDate(end),
        interval: 'day',
        breakdowns: JSON.stringify(['type', 'team']),
        usage_types: JSON.stringify(USAGE_TYPE_TO_KEY.map(([type]) => type)),
      },
      { scope: 'billing:read' },
    ),
  );
  let orgUsage = usageRaw ? parseBillingUsage(usageRaw, projectId, notes) : null;

  if (orgUsage && orgUsage.length > 1) {
    const names = await step('project names', () =>
      client.get<unknown>('/api/organizations/@current/projects/', { limit: 200 }, { scope: 'project:read' }),
    );
    if (names) orgUsage = applyProjectNames(orgUsage, names);
  }
  if (orgUsage) {
    const audited = orgUsage.find((p) => p.audited);
    if (audited && audited.name === null) audited.name = projectName;
  }

  const flagsRaw = await step('feature flags', () => listFlags(client, projectId));

  const results = new Map<QueryId, Array<Record<string, unknown>>>();
  for (const query of queries) {
    const rows = await runQuery(client, projectId, query, notes, progress);
    if (rows) results.set(query.id, rows);
    else if (query.id === 'totals') {
      throw new ApiError(
        'The first HogQL query failed, so there is nothing to analyze. Check that the key has the query:read scope and access to this project.',
        { status: null, path: 'query' },
      );
    }
  }

  const events = buildEvents(results);
  const replay = buildReplay(results);
  const flags: FlagsData | null =
    flagsRaw || results.has('flags_called')
      ? { definitions: flagsRaw, calledByLib: results.has('flags_called') ? parseFlagCalled(results.get('flags_called') ?? []) : null }
      : null;

  progress(`Done: ${client.requestCount} read-only request${client.requestCount === 1 ? '' : 's'}.`);
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    source: { kind: 'live', host: client.origin, toolVersion: options.toolVersion, fictional: false, label: null },
    project: { id: projectId, name: projectName },
    period: {
      days,
      start: new Date(now.getTime() - days * 86_400_000).toISOString(),
      end: now.toISOString(),
    },
    orgUsage,
    projectSettings,
    events,
    replay,
    flags,
    billing,
    notes,
  };
}

async function runQuery(
  client: PostHogReadOnlyClient,
  projectId: string,
  query: HogQLQuery,
  notes: string[],
  progress: (line: string) => void,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const rows = await client.hogql(projectId, query);
    progress(`  ✓ query ${query.id} (${rows.length} row${rows.length === 1 ? '' : 's'})`);
    return rows;
  } catch (error) {
    if (error instanceof ApiError && error.isAuthFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    progress(`  ✗ query ${query.id}: ${message}`);
    notes.push(`Query ${query.id} (${query.purpose}) failed: ${message}`);
    return null;
  }
}

async function listFlags(client: PostHogReadOnlyClient, projectId: string): Promise<FlagDefinition[]> {
  const out: FlagDefinition[] = [];
  let page = await client.get<unknown>(`/api/projects/${projectId}/feature_flags/`, { active: 'true', limit: 200 }, { scope: 'feature_flag:read' });
  for (let i = 0; i < 10; i += 1) {
    if (!isRecord(page) || !Array.isArray(page.results)) break;
    for (const raw of page.results) {
      const flag = parseFlag(raw);
      if (flag) out.push(flag);
    }
    if (typeof page.next !== 'string' || page.next === '') break;
    page = await client.getNext<unknown>(page.next, { scope: 'feature_flag:read' });
  }
  return out;
}

export function parseFlag(raw: unknown): FlagDefinition | null {
  if (!isRecord(raw) || typeof raw.key !== 'string' || raw.deleted === true) return null;
  const filters = JSON.stringify(raw.filters ?? {});
  return {
    key: raw.key,
    active: raw.active !== false,
    ensureExperienceContinuity: raw.ensure_experience_continuity === true,
    // Static cohorts can't be told apart from dynamic ones without reading cohorts; only flagged when the API says so.
    usesStaticCohort: /"is_static"\s*:\s*true/.test(filters),
    usesIsNotSet: /"operator"\s*:\s*"is_not_set"/.test(filters),
    evaluationRuntime: typeof raw.evaluation_runtime === 'string' ? raw.evaluation_runtime : null,
    lastCalledAt: typeof raw.last_called_at === 'string' ? raw.last_called_at : null,
  };
}

export function parseProjectSettings(raw: Record<string, unknown>): ProjectSettings {
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : isRecord(v) && Array.isArray(v.groups) ? v.groups.length : null);
  const rate = num(raw.session_recording_sample_rate);
  return {
    autocaptureOptOut: bool(raw.autocapture_opt_out),
    sessionRecordingOptIn: bool(raw.session_recording_opt_in),
    sessionRecordingSampleRate: rate === null ? null : Math.min(1, Math.max(0, rate)),
    sessionRecordingMinimumDurationMs: num(raw.session_recording_minimum_duration_milliseconds),
    sessionRecordingUrlTriggerCount: len(raw.session_recording_url_trigger_config),
    sessionRecordingTriggerGroupCount: len(raw.session_recording_trigger_groups),
    heatmapsOptIn: bool(raw.heatmaps_opt_in),
    captureDeadClicks: bool(raw.capture_dead_clicks),
  };
}

/** GET /api/billing/ → discount, existing limits and the organization's own tiers (defensive: the shape is loosely documented). */
export function parseBillingOverview(raw: unknown, notes: string[]): BillingInfo | null {
  if (!isRecord(raw)) return null;
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const limitsUsd: Partial<Record<ProductKey, number | null>> = {};
  if (isRecord(raw.custom_limits_usd)) {
    for (const [type, value] of Object.entries(raw.custom_limits_usd)) {
      const product = BILLING_TYPE_TO_PRODUCT[type] ?? (isProductKey(type) ? type : undefined);
      if (product) limitsUsd[product] = num(value);
    }
  }
  const pricing: PricingOverride = { products: {} };
  const products = Array.isArray(raw.products) ? raw.products : [];
  const readTiers = (p: Record<string, unknown>, label: string): ProductOverride | null => {
    if (!Array.isArray(p.tiers) || p.tiers.length === 0) return null;
    const issues = new Issues();
    const tiers = p.tiers.map((t, i) => parseTier(t, `${label}.tiers[${i}]`, issues)).filter((t): t is NonNullable<typeof t> => t !== null);
    if (!issues.ok || tiers.length !== p.tiers.length || tierProblems(tiers).length > 0) {
      notes.push(`Ignored the billing plan tiers for ${label} (unexpected shape); public prices are used for it.`);
      return null;
    }
    return { tiers };
  };
  for (const p of products) {
    if (!isRecord(p) || typeof p.type !== 'string') continue;
    const product = BILLING_TYPE_TO_PRODUCT[p.type];
    if (product && p.subscribed !== false) {
      const tiers = readTiers(p, p.type);
      if (tiers) pricing.products[product] = tiers;
    }
    for (const addon of Array.isArray(p.addons) ? p.addons : []) {
      if (!isRecord(addon) || typeof addon.type !== 'string') continue;
      const addonProduct = BILLING_TYPE_TO_PRODUCT[addon.type];
      if (addonProduct && addon.subscribed !== false) {
        const tiers = readTiers(addon, addon.type);
        if (tiers) pricing.products[addonProduct] = tiers;
      }
    }
  }
  const period = isRecord(raw.billing_period) ? raw.billing_period : {};
  const discount = num(raw.discount_percent);
  return {
    discountPercent: discount !== null && discount >= 0 && discount <= 100 ? discount : null,
    limitsUsd,
    pricing: Object.keys(pricing.products).length > 0 ? { ...pricing, name: 'Your billing plan', source: 'GET /api/billing/' } : null,
    projectedTotalUsd: num(raw.projected_total_amount_usd_after_discount) ?? num(raw.projected_total_amount_usd),
    currentTotalUsd: num(raw.current_total_amount_usd_after_discount) ?? num(raw.current_total_amount_usd),
    periodStart: typeof period.current_period_start === 'string' ? period.current_period_start : null,
    periodEnd: typeof period.current_period_end === 'string' ? period.current_period_end : null,
  };
}

/**
 * GET /api/billing/usage/ with breakdowns ["type","team"] → usage per project.
 * Each result is one series with a `breakdown_value` naming the usage type and the team (project) id.
 */
export function parseBillingUsage(raw: unknown, auditedProjectId: string, notes: string[]): ProjectUsage[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    notes.push('Organization usage had an unexpected shape; costs use this project only.');
    return null;
  }
  const types = new Map(USAGE_TYPE_TO_KEY);
  const byTeam = new Map<string, Usage>();
  const seen = new Set<UsageKey>();
  let parsed = 0;
  for (const series of raw.results) {
    if (!isRecord(series)) continue;
    const { type, team } = breakdownParts(series);
    if (!type || !types.has(type)) continue;
    const key = types.get(type) as UsageKey;
    seen.add(key);
    const data = Array.isArray(series.data) ? series.data : [];
    const total = data.reduce<number>((s, v) => s + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
    const teamId = team ?? auditedProjectId;
    const usage = byTeam.get(teamId) ?? emptyUsage();
    // Prefer the billable mobile count when both mobile series are present.
    if (key === 'mobileRecordings' && type === 'mobile_recording_count_in_period' && usage.mobileRecordings !== null) continue;
    usage[key] = type === 'mobile_billable_recording_count_in_period' ? total : (usage[key] ?? 0) + total;
    byTeam.set(teamId, usage);
    parsed += 1;
  }
  if (parsed === 0) {
    notes.push('Organization usage contained no recognizable series; costs use this project only.');
    return null;
  }
  // A meter reported for some project but not another means zero there; a meter never reported stays unknown.
  for (const usage of byTeam.values()) for (const key of seen) if (usage[key] === null) usage[key] = 0;
  return [...byTeam.entries()]
    .map(([projectId, usage]) => ({ projectId, name: null, audited: projectId === auditedProjectId, usage }))
    .sort((a, b) => Number(b.audited) - Number(a.audited) || (b.usage.events ?? 0) - (a.usage.events ?? 0));
}

function breakdownParts(series: Record<string, unknown>): { type: string | null; team: string | null } {
  const value = series.breakdown_value;
  const parts: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/::|,|\|/) : value === undefined || value === null ? [] : [value];
  let type: string | null = null;
  let team: string | null = null;
  for (const part of parts) {
    const s = String(part).trim();
    if (/_in_period$/.test(s)) type = s;
    else if (/^\d+$/.test(s)) team = s;
  }
  if (!type && typeof series.label === 'string') {
    const m = /([a-z_]+_in_period)/.exec(series.label);
    if (m) type = m[1] ?? null;
  }
  if (!type && series.breakdown_type === 'type' && typeof value === 'string') type = value;
  return { type, team };
}

function applyProjectNames(rows: ProjectUsage[], raw: unknown): ProjectUsage[] {
  const list = isRecord(raw) && Array.isArray(raw.results) ? raw.results : Array.isArray(raw) ? raw : [];
  const names = new Map<string, string>();
  for (const p of list) if (isRecord(p) && (typeof p.id === 'number' || typeof p.id === 'string') && typeof p.name === 'string') names.set(String(p.id), p.name);
  return rows.map((r) => ({ ...r, name: r.name ?? names.get(r.projectId) ?? null }));
}

/** A HogQL cell as text: strings as-is, other primitives via String(), anything structured as JSON. */
const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
};
const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0;
};
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));

export function buildEvents(results: Map<QueryId, Array<Record<string, unknown>>>): EventsData | null {
  const totalsRow = results.get('totals')?.[0];
  if (!totalsRow) return null;
  const get = (id: QueryId) => results.get(id) ?? null;
  return {
    totals: {
      all: nOrNull(totalsRow.all_events),
      billable: n(totalsRow.billable),
      billableIdentified: nOrNull(totalsRow.billable_identified),
      unidentifiedPersonEvents: nOrNull(totalsRow.unidentified_person_events),
    },
    byEvent: (get('events_by_name') ?? []).map((r) => ({ event: str(r.event) ?? '', count: n(r.total), identified: nOrNull(r.identified) })),
    byLib: get('by_lib')?.map((r) => ({ lib: str(r.lib) ?? '(none)', count: n(r.total), identified: nOrNull(r.identified) })) ?? null,
    byHost: get('by_host')?.map((r) => ({ host: str(r.host) ?? '', count: n(r.total), identified: nOrNull(r.identified) })) ?? null,
    byPage:
      get('by_page')?.map((r) => ({
        host: str(r.host) ?? '',
        path: str(r.path) ?? '/',
        count: n(r.total),
        identified: nOrNull(r.identified),
        unidentifiedPersonEvents: nOrNull(r.unidentified_person_events),
        pageviews: n(r.pageviews),
        pageleaves: n(r.pageleaves),
        autocapture: n(r.autocapture),
      })) ?? null,
    autocaptureDomEvents: get('autocapture_dom_events')?.map((r) => ({ domEvent: str(r.dom_event), host: str(r.host), count: n(r.total) })) ?? null,
    autocaptureElements:
      get('autocapture_elements')?.map((r) => ({
        host: str(r.host),
        domEvent: str(r.dom_event),
        tag: emptyToNull(str(r.tag)),
        classes: emptyToNull(str(r.classes)),
        text: emptyToNull(str(r.text)),
        count: n(r.total),
        sessions: nOrNull(r.sessions),
      })) ?? null,
    identity: get('identity')?.map((r) => ({ event: str(r.event) ?? '', lib: str(r.lib), count: n(r.total), necessary: n(r.necessary) })) ?? null,
    bots: get('bots')?.map((r) => ({ userAgent: str(r.user_agent) ?? '(unknown bot)', lib: str(r.lib), count: n(r.total), identified: nOrNull(r.identified) })) ?? null,
    serverEvents: get('server_events')?.map((r) => ({ lib: str(r.lib) ?? '', event: str(r.event) ?? '', count: n(r.total), identified: nOrNull(r.identified) })) ?? null,
  };
}

function emptyToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

export function buildReplay(results: Map<QueryId, Array<Record<string, unknown>>>): ReplayData | null {
  const summary = results.get('replay_summary')?.[0];
  if (!summary) return null;
  return {
    recordings: n(summary.recordings),
    durations: { under5s: n(summary.under_5s), under10s: n(summary.under_10s), under30s: n(summary.under_30s), under60s: n(summary.under_60s) },
    activeUnder5s: nOrNull(summary.active_under_5s),
    byFirstUrl: results.get('replay_first_urls')?.map((r) => ({ url: str(r.url) ?? '', count: n(r.total), under5s: n(r.under_5s), singleUrl: nOrNull(r.single_url) })) ?? null,
  };
}

export function parseFlagCalled(rows: Array<Record<string, unknown>>): FlagsData['calledByLib'] {
  return rows.map((r) => {
    const raw = str(r.locally_evaluated)?.toLowerCase() ?? null;
    const locallyEvaluated = raw === 'true' || raw === '1' ? 'true' : raw === 'false' || raw === '0' ? 'false' : null;
    return { lib: str(r.lib), locallyEvaluated, count: n(r.total), flags: nOrNull(r.flags) };
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

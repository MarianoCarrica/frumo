/**
 * The frumo snapshot: everything the audit needs, in one JSON document.
 *
 * Live mode collects exactly this shape (and can save it with --save-snapshot); offline mode
 * reads it back with --from. All counts cover the window in `period.days` (they are normalized
 * to a 30-day month during analysis). Every section except `period` is optional: analyses that
 * lack data are skipped and reported as "not analyzed".
 *
 * See README.md → "Snapshot format" for an annotated example.
 */
import type { PricingOverride } from './pricing/override.js';
import { parsePricingOverride } from './pricing/override.js';
import { PRODUCT_KEYS, isProductKey } from './pricing/types.js';
import type { ProductKey } from './pricing/types.js';
import { Issues } from './util/validate.js';

export const SNAPSHOT_SCHEMA = 'frumo.snapshot/v1';

/**
 * Older schema ids for the same v1 format, still accepted when reading (and rewritten to
 * SNAPSHOT_SCHEMA). hogpost.snapshot/v1 is what the tool wrote before it was renamed to frumo.
 */
export const LEGACY_SNAPSHOT_SCHEMAS: readonly string[] = ['hogpost.snapshot/v1'];

/** Usage meters PostHog bills on (organization-wide). */
export const USAGE_KEYS = [
  'events',
  'identifiedEvents',
  'recordings',
  'mobileRecordings',
  'flagRequests',
  'surveyResponses',
  'exceptions',
] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];

/** Which price list each usage meter is charged on. */
export const PRODUCT_FOR_USAGE: Readonly<Record<UsageKey, ProductKey>> = {
  events: 'product_analytics',
  identifiedEvents: 'identified_events',
  recordings: 'session_replay',
  mobileRecordings: 'mobile_replay',
  flagRequests: 'feature_flags',
  surveyResponses: 'surveys',
  exceptions: 'error_tracking',
};

export type Usage = Record<UsageKey, number | null>;

export interface ProjectUsage {
  projectId: string;
  name: string | null;
  /** True for the project the events/replay/flags sections describe. */
  audited: boolean;
  usage: Usage;
}

export interface EventCount {
  event: string;
  count: number;
  /** Events processed with a person profile (billed as identified). null = unknown. */
  identified: number | null;
}

export interface LibCount {
  lib: string;
  count: number;
  identified: number | null;
}

export interface HostCount {
  host: string;
  count: number;
  identified: number | null;
}

export interface PageRow {
  host: string;
  path: string;
  count: number;
  identified: number | null;
  /** Identified events sent while posthog-js reported the user as not identified ($is_identified = false). */
  unidentifiedPersonEvents: number | null;
  pageviews: number;
  pageleaves: number;
  autocapture: number;
}

export interface AutocaptureDomEventRow {
  domEvent: string | null;
  host: string | null;
  count: number;
}

export interface AutocaptureElementRow {
  host: string | null;
  domEvent: string | null;
  tag: string | null;
  classes: string | null;
  text: string | null;
  count: number;
  sessions: number | null;
}

export interface IdentityRow {
  /** $identify, $set, $groupidentify or $create_alias */
  event: string;
  lib: string | null;
  count: number;
  /** Distinct (session, distinct_id, day, group) combinations: the calls that were not repeats. */
  necessary: number;
}

export interface UserAgentRow {
  userAgent: string;
  lib: string | null;
  count: number;
  identified: number | null;
}

export interface ServerEventRow {
  lib: string;
  event: string;
  count: number;
  identified: number | null;
}

export interface EventsData {
  totals: {
    /** All events including ones PostHog doesn't bill as analytics events. */
    all: number | null;
    /** Events billed as product analytics events. */
    billable: number;
    /** Billable events processed with a person profile. */
    billableIdentified: number | null;
    /** Billable identified events from users posthog-js reported as not identified. */
    unidentifiedPersonEvents: number | null;
  };
  byEvent: EventCount[];
  byLib: LibCount[] | null;
  byHost: HostCount[] | null;
  byPage: PageRow[] | null;
  autocaptureDomEvents: AutocaptureDomEventRow[] | null;
  autocaptureElements: AutocaptureElementRow[] | null;
  identity: IdentityRow[] | null;
  bots: UserAgentRow[] | null;
  serverEvents: ServerEventRow[] | null;
}

export interface ReplayData {
  /** Web recordings in the window (from session_replay_events). */
  recordings: number;
  durations: { under5s: number; under10s: number; under30s: number; under60s: number } | null;
  /** Recordings with under 5s of activity. */
  activeUnder5s: number | null;
  byFirstUrl: Array<{ url: string; count: number; under5s: number; singleUrl: number | null }> | null;
}

export interface FlagDefinition {
  key: string;
  active: boolean;
  ensureExperienceContinuity: boolean;
  usesStaticCohort: boolean;
  usesIsNotSet: boolean;
  evaluationRuntime: string | null;
  lastCalledAt: string | null;
}

export interface FlagCalledRow {
  lib: string | null;
  /** "true" / "false" / null, from the $feature_flag_called property `locally_evaluated` (server SDKs). */
  locallyEvaluated: string | null;
  count: number;
  flags: number | null;
}

export interface FlagsData {
  definitions: FlagDefinition[] | null;
  calledByLib: FlagCalledRow[] | null;
}

export interface ProjectSettings {
  autocaptureOptOut: boolean | null;
  sessionRecordingOptIn: boolean | null;
  /** 0..1, null = not set (records everything). */
  sessionRecordingSampleRate: number | null;
  sessionRecordingMinimumDurationMs: number | null;
  sessionRecordingUrlTriggerCount: number | null;
  sessionRecordingTriggerGroupCount: number | null;
  heatmapsOptIn: boolean | null;
  captureDeadClicks: boolean | null;
}

export interface BillingInfo {
  discountPercent: number | null;
  /** Billing limits already set, in USD per month. null = no limit / unknown. */
  limitsUsd: Partial<Record<ProductKey, number | null>>;
  /** Tiers read from the organization's own plan, when available. */
  pricing: PricingOverride | null;
  projectedTotalUsd: number | null;
  currentTotalUsd: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export type SourceKind = 'live' | 'demo' | 'csv' | 'file';

export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  generatedAt: string;
  source: {
    kind: SourceKind;
    /** PostHog host the data came from (live mode). Never contains credentials. */
    host: string | null;
    toolVersion: string;
    /** True for the bundled demo data. */
    fictional: boolean;
    label: string | null;
  };
  project: { id: string | null; name: string | null };
  period: { days: number; start: string | null; end: string | null };
  orgUsage: ProjectUsage[] | null;
  projectSettings: ProjectSettings | null;
  events: EventsData | null;
  replay: ReplayData | null;
  flags: FlagsData | null;
  billing: BillingInfo | null;
  notes: string[];
}

export function emptyUsage(): Usage {
  return {
    events: null,
    identifiedEvents: null,
    recordings: null,
    mobileRecordings: null,
    flagRequests: null,
    surveyResponses: null,
    exceptions: null,
  };
}

const MAX_ROWS = 50_000;

/** Validates untrusted JSON (e.g. a --from file) into a Snapshot. Throws ValidationError. */
export function parseSnapshot(json: unknown, what = 'Snapshot'): Snapshot {
  const v = new Issues();
  const root = v.record(json, '');
  if (!root) v.throwIfAny(what);
  const r = root as Record<string, unknown>;

  const knownSchema = r.schema === SNAPSHOT_SCHEMA || (typeof r.schema === 'string' && LEGACY_SNAPSHOT_SCHEMAS.includes(r.schema));
  if (!knownSchema) {
    v.add('schema', `expected "${SNAPSHOT_SCHEMA}" (is this a frumo snapshot? CSV files need a .csv extension)`);
    v.throwIfAny(what);
  }

  const source = v.optionalRecord(r.source, 'source');
  const kindRaw = source?.kind;
  const kind: SourceKind = kindRaw === 'live' || kindRaw === 'demo' || kindRaw === 'csv' || kindRaw === 'file' ? kindRaw : 'file';
  const period = v.record(r.period, 'period');
  const days = period ? v.numberInRange(period.days, 'period.days', 1, 366) : null;
  const project = v.optionalRecord(r.project, 'project');

  const snapshot: Snapshot = {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: v.nullableString(r.generatedAt, 'generatedAt', 64) ?? new Date(0).toISOString(),
    source: {
      kind,
      host: source ? v.nullableString(source.host, 'source.host', 500) : null,
      toolVersion: (source ? v.nullableString(source.toolVersion, 'source.toolVersion', 40) : null) ?? 'unknown',
      fictional: (source ? v.nullableBoolean(source.fictional, 'source.fictional') : null) ?? false,
      label: source ? v.nullableString(source.label, 'source.label', 300) : null,
    },
    project: {
      id: project ? idString(project.id, 'project.id', v) : null,
      name: project ? v.nullableString(project.name, 'project.name', 300) : null,
    },
    period: {
      days: days ?? 30,
      start: period ? v.nullableString(period.start, 'period.start', 40) : null,
      end: period ? v.nullableString(period.end, 'period.end', 40) : null,
    },
    orgUsage: parseOrgUsage(r.orgUsage, v),
    projectSettings: parseProjectSettings(r.projectSettings, v),
    events: parseEvents(r.events, v),
    replay: parseReplay(r.replay, v),
    flags: parseFlags(r.flags, v),
    billing: parseBilling(r.billing, v),
    notes: parseStringList(r.notes, 'notes', v),
  };
  v.throwIfAny(what);
  return snapshot;
}

function idString(value: unknown, path: string, v: Issues): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return v.string(value, path, 100);
}

function parseStringList(value: unknown, path: string, v: Issues): string[] {
  const arr = v.optionalArray(value, path, 500);
  if (!arr) return [];
  const out: string[] = [];
  arr.forEach((item, i) => {
    const s = v.string(item, `${path}[${i}]`, 2_000);
    if (s !== null) out.push(s);
  });
  return out;
}

function parseUsage(value: unknown, path: string, v: Issues): Usage {
  const usage = emptyUsage();
  const obj = v.optionalRecord(value, path);
  if (!obj) return usage;
  for (const key of Object.keys(obj)) {
    if (!(USAGE_KEYS as readonly string[]).includes(key)) v.add(`${path}.${key}`, `unknown usage meter (allowed: ${USAGE_KEYS.join(', ')})`);
  }
  for (const key of USAGE_KEYS) usage[key] = v.nullableCount(obj[key], `${path}.${key}`);
  return usage;
}

function parseOrgUsage(value: unknown, v: Issues): ProjectUsage[] | null {
  const arr = v.optionalArray(value, 'orgUsage', 1_000);
  if (!arr) return null;
  const out: ProjectUsage[] = [];
  arr.forEach((item, i) => {
    const path = `orgUsage[${i}]`;
    const obj = v.record(item, path);
    if (!obj) return;
    const id = idString(obj.projectId, `${path}.projectId`, v);
    const name = v.nullableString(obj.name, `${path}.name`, 300);
    const audited = v.nullableBoolean(obj.audited, `${path}.audited`) ?? false;
    const usage = parseUsage(obj.usage, `${path}.usage`, v);
    if (id === null) {
      v.add(`${path}.projectId`, 'required');
      return;
    }
    out.push({ projectId: id, name, audited, usage });
  });
  return out;
}

function parseProjectSettings(value: unknown, v: Issues): ProjectSettings | null {
  const o = v.optionalRecord(value, 'projectSettings');
  if (!o) return null;
  const p = 'projectSettings';
  const sample = o.sessionRecordingSampleRate;
  return {
    autocaptureOptOut: v.nullableBoolean(o.autocaptureOptOut, `${p}.autocaptureOptOut`),
    sessionRecordingOptIn: v.nullableBoolean(o.sessionRecordingOptIn, `${p}.sessionRecordingOptIn`),
    sessionRecordingSampleRate:
      sample === undefined || sample === null ? null : v.numberInRange(sample, `${p}.sessionRecordingSampleRate`, 0, 1),
    sessionRecordingMinimumDurationMs: v.nullableCount(o.sessionRecordingMinimumDurationMs, `${p}.sessionRecordingMinimumDurationMs`),
    sessionRecordingUrlTriggerCount: v.nullableCount(o.sessionRecordingUrlTriggerCount, `${p}.sessionRecordingUrlTriggerCount`),
    sessionRecordingTriggerGroupCount: v.nullableCount(o.sessionRecordingTriggerGroupCount, `${p}.sessionRecordingTriggerGroupCount`),
    heatmapsOptIn: v.nullableBoolean(o.heatmapsOptIn, `${p}.heatmapsOptIn`),
    captureDeadClicks: v.nullableBoolean(o.captureDeadClicks, `${p}.captureDeadClicks`),
  };
}

type RowParser<T> = (o: Record<string, unknown>, path: string) => T | null;

function rows<T>(value: unknown, path: string, v: Issues, parse: RowParser<T>): T[] | null {
  const arr = v.optionalArray(value, path, MAX_ROWS);
  if (!arr) return null;
  const out: T[] = [];
  arr.forEach((item, i) => {
    const obj = v.record(item, `${path}[${i}]`);
    if (!obj) return;
    const row = parse(obj, `${path}[${i}]`);
    if (row !== null) out.push(row);
  });
  return out;
}

function requiredCount(v: Issues, value: unknown, path: string): number {
  return v.count(value, path) ?? 0;
}

function parseEvents(value: unknown, v: Issues): EventsData | null {
  const o = v.optionalRecord(value, 'events');
  if (!o) return null;
  const totalsObj = v.record(o.totals, 'events.totals');
  const byEvent = rows(o.byEvent, 'events.byEvent', v, (r, p) => ({
    event: v.string(r.event, `${p}.event`, 400) ?? '',
    count: requiredCount(v, r.count, `${p}.count`),
    identified: v.nullableCount(r.identified, `${p}.identified`),
  }));
  if (!byEvent) v.add('events.byEvent', 'required (use an empty array if unknown)');
  return {
    totals: {
      all: totalsObj ? v.nullableCount(totalsObj.all, 'events.totals.all') : null,
      billable: totalsObj ? requiredCount(v, totalsObj.billable, 'events.totals.billable') : 0,
      billableIdentified: totalsObj ? v.nullableCount(totalsObj.billableIdentified, 'events.totals.billableIdentified') : null,
      unidentifiedPersonEvents: totalsObj
        ? v.nullableCount(totalsObj.unidentifiedPersonEvents, 'events.totals.unidentifiedPersonEvents')
        : null,
    },
    byEvent: byEvent ?? [],
    byLib: rows(o.byLib, 'events.byLib', v, (r, p) => ({
      lib: v.nullableString(r.lib, `${p}.lib`, 200) ?? '(none)',
      count: requiredCount(v, r.count, `${p}.count`),
      identified: v.nullableCount(r.identified, `${p}.identified`),
    })),
    byHost: rows(o.byHost, 'events.byHost', v, (r, p) => ({
      host: v.nullableString(r.host, `${p}.host`, 500) ?? '',
      count: requiredCount(v, r.count, `${p}.count`),
      identified: v.nullableCount(r.identified, `${p}.identified`),
    })),
    byPage: rows(o.byPage, 'events.byPage', v, (r, p) => ({
      host: v.nullableString(r.host, `${p}.host`, 500) ?? '',
      path: v.nullableString(r.path, `${p}.path`, 2_000) ?? '',
      count: requiredCount(v, r.count, `${p}.count`),
      identified: v.nullableCount(r.identified, `${p}.identified`),
      unidentifiedPersonEvents: v.nullableCount(r.unidentifiedPersonEvents, `${p}.unidentifiedPersonEvents`),
      pageviews: v.nullableCount(r.pageviews, `${p}.pageviews`) ?? 0,
      pageleaves: v.nullableCount(r.pageleaves, `${p}.pageleaves`) ?? 0,
      autocapture: v.nullableCount(r.autocapture, `${p}.autocapture`) ?? 0,
    })),
    autocaptureDomEvents: rows(o.autocaptureDomEvents, 'events.autocaptureDomEvents', v, (r, p) => ({
      domEvent: v.nullableString(r.domEvent, `${p}.domEvent`, 100),
      host: v.nullableString(r.host, `${p}.host`, 500),
      count: requiredCount(v, r.count, `${p}.count`),
    })),
    autocaptureElements: rows(o.autocaptureElements, 'events.autocaptureElements', v, (r, p) => ({
      host: v.nullableString(r.host, `${p}.host`, 500),
      domEvent: v.nullableString(r.domEvent, `${p}.domEvent`, 100),
      tag: v.nullableString(r.tag, `${p}.tag`, 100),
      classes: v.nullableString(r.classes, `${p}.classes`, 1_000),
      text: v.nullableString(r.text, `${p}.text`, 400),
      count: requiredCount(v, r.count, `${p}.count`),
      sessions: v.nullableCount(r.sessions, `${p}.sessions`),
    })),
    identity: rows(o.identity, 'events.identity', v, (r, p) => ({
      event: v.string(r.event, `${p}.event`, 100) ?? '',
      lib: v.nullableString(r.lib, `${p}.lib`, 200),
      count: requiredCount(v, r.count, `${p}.count`),
      necessary: requiredCount(v, r.necessary, `${p}.necessary`),
    })),
    bots: rows(o.bots, 'events.bots', v, (r, p) => ({
      userAgent: v.string(r.userAgent, `${p}.userAgent`, 2_000) ?? '',
      lib: v.nullableString(r.lib, `${p}.lib`, 200),
      count: requiredCount(v, r.count, `${p}.count`),
      identified: v.nullableCount(r.identified, `${p}.identified`),
    })),
    serverEvents: rows(o.serverEvents, 'events.serverEvents', v, (r, p) => ({
      lib: v.string(r.lib, `${p}.lib`, 200) ?? '',
      event: v.string(r.event, `${p}.event`, 400) ?? '',
      count: requiredCount(v, r.count, `${p}.count`),
      identified: v.nullableCount(r.identified, `${p}.identified`),
    })),
  };
}

function parseReplay(value: unknown, v: Issues): ReplayData | null {
  const o = v.optionalRecord(value, 'replay');
  if (!o) return null;
  const d = v.optionalRecord(o.durations, 'replay.durations');
  return {
    recordings: requiredCount(v, o.recordings, 'replay.recordings'),
    durations: d
      ? {
          under5s: requiredCount(v, d.under5s, 'replay.durations.under5s'),
          under10s: requiredCount(v, d.under10s, 'replay.durations.under10s'),
          under30s: requiredCount(v, d.under30s, 'replay.durations.under30s'),
          under60s: requiredCount(v, d.under60s, 'replay.durations.under60s'),
        }
      : null,
    activeUnder5s: v.nullableCount(o.activeUnder5s, 'replay.activeUnder5s'),
    byFirstUrl: rows(o.byFirstUrl, 'replay.byFirstUrl', v, (r, p) => ({
      url: v.nullableString(r.url, `${p}.url`, 2_000) ?? '',
      count: requiredCount(v, r.count, `${p}.count`),
      under5s: v.nullableCount(r.under5s, `${p}.under5s`) ?? 0,
      singleUrl: v.nullableCount(r.singleUrl, `${p}.singleUrl`),
    })),
  };
}

function parseFlags(value: unknown, v: Issues): FlagsData | null {
  const o = v.optionalRecord(value, 'flags');
  if (!o) return null;
  return {
    definitions: rows(o.definitions, 'flags.definitions', v, (r, p) => ({
      key: v.string(r.key, `${p}.key`, 400) ?? '',
      active: v.nullableBoolean(r.active, `${p}.active`) ?? true,
      ensureExperienceContinuity: v.nullableBoolean(r.ensureExperienceContinuity, `${p}.ensureExperienceContinuity`) ?? false,
      usesStaticCohort: v.nullableBoolean(r.usesStaticCohort, `${p}.usesStaticCohort`) ?? false,
      usesIsNotSet: v.nullableBoolean(r.usesIsNotSet, `${p}.usesIsNotSet`) ?? false,
      evaluationRuntime: v.nullableString(r.evaluationRuntime, `${p}.evaluationRuntime`, 40),
      lastCalledAt: v.nullableString(r.lastCalledAt, `${p}.lastCalledAt`, 64),
    })),
    calledByLib: rows(o.calledByLib, 'flags.calledByLib', v, (r, p) => ({
      lib: v.nullableString(r.lib, `${p}.lib`, 200),
      locallyEvaluated: v.nullableString(r.locallyEvaluated, `${p}.locallyEvaluated`, 20),
      count: requiredCount(v, r.count, `${p}.count`),
      flags: v.nullableCount(r.flags, `${p}.flags`),
    })),
  };
}

function parseBilling(value: unknown, v: Issues): BillingInfo | null {
  const o = v.optionalRecord(value, 'billing');
  if (!o) return null;
  const limitsUsd: Partial<Record<ProductKey, number | null>> = {};
  const limits = v.optionalRecord(o.limitsUsd, 'billing.limitsUsd');
  if (limits) {
    for (const [key, raw] of Object.entries(limits)) {
      if (!isProductKey(key)) {
        v.add(`billing.limitsUsd.${key}`, `unknown product (allowed: ${PRODUCT_KEYS.join(', ')})`);
        continue;
      }
      limitsUsd[key] = v.nullableCount(raw, `billing.limitsUsd.${key}`);
    }
  }
  let pricing: PricingOverride | null = null;
  if (o.pricing !== undefined && o.pricing !== null) {
    try {
      pricing = parsePricingOverride(o.pricing, 'billing.pricing');
    } catch (error) {
      v.add('billing.pricing', error instanceof Error ? error.message : String(error));
    }
  }
  const discount = o.discountPercent;
  return {
    discountPercent: discount === undefined || discount === null ? null : v.numberInRange(discount, 'billing.discountPercent', 0, 100),
    limitsUsd,
    pricing,
    projectedTotalUsd: v.nullableCount(o.projectedTotalUsd, 'billing.projectedTotalUsd'),
    currentTotalUsd: v.nullableCount(o.currentTotalUsd, 'billing.currentTotalUsd'),
    periodStart: v.nullableString(o.periodStart, 'billing.periodStart', 64),
    periodEnd: v.nullableString(o.periodEnd, 'billing.periodEnd', 64),
  };
}

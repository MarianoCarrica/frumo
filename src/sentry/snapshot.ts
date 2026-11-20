/**
 * The frumo Sentry snapshot: everything `frumo sentry` needs, in one JSON document.
 *
 * Live mode collects exactly this shape (and can save it with --save-snapshot); `frumo sentry
 * --from <file>` reads it back. Counts cover `period.days` and are normalized to a 30-day month
 * during analysis.
 *
 * The parser copies only the fields listed here, so anything else in the input (for example the
 * DSNs and key secrets the Sentry client-keys API returns) is dropped, never carried along.
 */
import { Issues, isRecord } from '../util/validate.js';

export const SENTRY_SNAPSHOT_SCHEMA = 'frumo.sentry-snapshot/v1';

/** stats_v2 categories frumo reads. `transaction` is treated as billable spans. */
export const SENTRY_STAT_CATEGORIES = ['error', 'transaction', 'replay', 'attachment'] as const;
export type SentryStatCategory = (typeof SENTRY_STAT_CATEGORIES)[number];

export function isStatCategory(value: unknown): value is SentryStatCategory {
  return typeof value === 'string' && (SENTRY_STAT_CATEGORIES as readonly string[]).includes(value);
}

export type SentrySourceKind = 'demo' | 'live' | 'file';

/** One stats_v2 group: volume for a project, category and outcome over the period. */
export interface SentryStatRow {
  projectId: string;
  category: SentryStatCategory;
  /** accepted, filtered, rate_limited, invalid, client_discard, abuse, … Only accepted is billed. */
  outcome: string;
  /** Events (or bytes, for attachments) in the period. */
  quantity: number;
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string | null;
  platform: string | null;
}

export interface SentryIssue {
  id: string;
  shortId: string | null;
  title: string;
  culprit: string | null;
  /** Events in the period. */
  count: number;
  /** unresolved, resolved, ignored (shown as "archived" in newer Sentry UIs). */
  status: string;
  substatus: string | null;
  projectSlug: string | null;
  level: string | null;
}

export interface SentryFilter {
  /** Built-in filter id from the filters API, e.g. browser-extensions, web-crawlers, localhost. */
  id: string;
  active: boolean;
}

/** Client key (DSN) metadata. Never the DSN, the key id or the public/secret key. */
export interface SentryKeyInfo {
  label: string;
  isActive: boolean;
  rateLimit: { window: number; count: number } | null;
}

export interface SentryProjectConfig {
  projectSlug: string;
  /** null = not readable (the note says why). */
  filters: SentryFilter[] | null;
  keys: SentryKeyInfo[] | null;
}

export interface SentrySnapshot {
  schema: typeof SENTRY_SNAPSHOT_SCHEMA;
  generatedAt: string;
  source: { kind: SentrySourceKind; host: string | null; toolVersion: string; fictional: boolean; label: string | null };
  org: { slug: string; name: string | null };
  period: { days: number; start: string | null; end: string | null };
  /** null = stats not available. A category with no rows had no volume (or failed: see notes). */
  stats: SentryStatRow[] | null;
  /** Categories whose stats could not be read. */
  statsMissing: SentryStatCategory[];
  projects: SentryProject[] | null;
  issues: SentryIssue[] | null;
  projectConfigs: SentryProjectConfig[];
  notes: string[];
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/** Validates untrusted JSON (fixture, --from file) and returns a clean snapshot with only known fields. */
export function parseSentrySnapshot(json: unknown, what = 'Sentry snapshot'): SentrySnapshot {
  const issues = new Issues();
  const root = issues.record(json, '');
  if (!root) issues.throwIfAny(what);
  const r = root ?? {};
  if (r.schema !== SENTRY_SNAPSHOT_SCHEMA) issues.add('schema', `expected "${SENTRY_SNAPSHOT_SCHEMA}"`);

  const source = issues.optionalRecord(r.source, 'source') ?? {};
  const kind: SentrySourceKind = source.kind === 'demo' || source.kind === 'live' ? source.kind : 'file';
  const org = issues.record(r.org, 'org') ?? {};
  const slug = issues.string(org.slug, 'org.slug', 100) ?? '';
  if (slug && !isSlug(slug)) issues.add('org.slug', 'not a valid organization slug');
  const period = issues.record(r.period, 'period') ?? {};
  const days = issues.numberInRange(period.days, 'period.days', 1, 366) ?? 30;

  const stats = issues.optionalArray(r.stats, 'stats')?.flatMap((row, i): SentryStatRow[] => {
    const at = `stats[${i}]`;
    const rec = issues.record(row, at);
    if (!rec) return [];
    const projectId = idString(rec.projectId, `${at}.projectId`, issues);
    if (!isStatCategory(rec.category)) {
      issues.add(`${at}.category`, `expected one of ${SENTRY_STAT_CATEGORIES.join(', ')}`);
      return [];
    }
    const outcome = issues.string(rec.outcome, `${at}.outcome`, 50);
    const quantity = issues.count(rec.quantity, `${at}.quantity`);
    if (projectId === null || outcome === null || quantity === null) return [];
    return [{ projectId, category: rec.category, outcome, quantity }];
  }) ?? null;

  const statsMissing = (issues.optionalArray(r.statsMissing, 'statsMissing') ?? []).filter(isStatCategory);

  const projects = issues.optionalArray(r.projects, 'projects')?.flatMap((row, i): SentryProject[] => {
    const at = `projects[${i}]`;
    const rec = issues.record(row, at);
    if (!rec) return [];
    const id = idString(rec.id, `${at}.id`, issues);
    const projectSlug = issues.string(rec.slug, `${at}.slug`, 100);
    if (id === null || projectSlug === null) return [];
    return [{ id, slug: projectSlug, name: issues.nullableString(rec.name, `${at}.name`, 200), platform: issues.nullableString(rec.platform, `${at}.platform`, 100) }];
  }) ?? null;

  const issueList = issues.optionalArray(r.issues, 'issues', 10_000)?.flatMap((row, i): SentryIssue[] => {
    const at = `issues[${i}]`;
    const rec = issues.record(row, at);
    if (!rec) return [];
    const id = idString(rec.id, `${at}.id`, issues);
    const title = issues.string(rec.title, `${at}.title`, 2_000);
    const count = issues.count(rec.count, `${at}.count`);
    const status = issues.string(rec.status, `${at}.status`, 50);
    if (id === null || title === null || count === null || status === null) return [];
    return [
      {
        id,
        shortId: issues.nullableString(rec.shortId, `${at}.shortId`, 100),
        title,
        culprit: issues.nullableString(rec.culprit, `${at}.culprit`, 2_000),
        count,
        status,
        substatus: issues.nullableString(rec.substatus, `${at}.substatus`, 100),
        projectSlug: issues.nullableString(rec.projectSlug, `${at}.projectSlug`, 100),
        level: issues.nullableString(rec.level, `${at}.level`, 50),
      },
    ];
  }) ?? null;

  const projectConfigs = (issues.optionalArray(r.projectConfigs, 'projectConfigs') ?? []).flatMap((row, i): SentryProjectConfig[] => {
    const at = `projectConfigs[${i}]`;
    const rec = issues.record(row, at);
    if (!rec) return [];
    const projectSlug = issues.string(rec.projectSlug, `${at}.projectSlug`, 100);
    if (projectSlug === null) return [];
    const filters = issues.optionalArray(rec.filters, `${at}.filters`)?.flatMap((f, j): SentryFilter[] => {
      const fr = issues.record(f, `${at}.filters[${j}]`);
      const id = fr ? issues.string(fr.id, `${at}.filters[${j}].id`, 100) : null;
      if (!fr || id === null) return [];
      return [{ id, active: filterActive(fr.active) }];
    }) ?? null;
    const keys = issues.optionalArray(rec.keys, `${at}.keys`)?.flatMap((k, j): SentryKeyInfo[] => {
      const kr = issues.record(k, `${at}.keys[${j}]`);
      if (!kr) return [];
      return [sanitizeKey(kr, j)];
    }) ?? null;
    return [{ projectSlug, filters, keys }];
  });

  const notes = (issues.optionalArray(r.notes, 'notes') ?? []).filter((n): n is string => typeof n === 'string');
  issues.throwIfAny(what);

  return {
    schema: SENTRY_SNAPSHOT_SCHEMA,
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : new Date(0).toISOString(),
    source: {
      kind,
      host: typeof source.host === 'string' ? source.host : null,
      toolVersion: typeof source.toolVersion === 'string' ? source.toolVersion : 'unknown',
      fictional: source.fictional === true,
      label: typeof source.label === 'string' ? source.label : null,
    },
    org: { slug, name: typeof org.name === 'string' ? org.name : null },
    period: { days, start: typeof period.start === 'string' ? period.start : null, end: typeof period.end === 'string' ? period.end : null },
    stats,
    statsMissing,
    projects,
    issues: issueList,
    projectConfigs,
    notes,
  };
}

/**
 * Client-key metadata frumo keeps: a label, whether the key is active, and its rate limit.
 * The key id (which is the public key), the DSNs and the secret key are deliberately dropped.
 */
export function sanitizeKey(raw: Record<string, unknown>, index: number): SentryKeyInfo {
  const name = typeof raw.label === 'string' && raw.label.trim() ? raw.label : typeof raw.name === 'string' && raw.name.trim() ? raw.name : '';
  const label = name && !/^[0-9a-f]{24,}$/i.test(name) ? name.slice(0, 80) : `key ${index + 1}`;
  const rl = isRecord(raw.rateLimit) ? raw.rateLimit : null;
  const window = rl && typeof rl.window === 'number' && Number.isFinite(rl.window) ? rl.window : null;
  const count = rl && typeof rl.count === 'number' && Number.isFinite(rl.count) ? rl.count : null;
  return {
    label,
    isActive: raw.isActive !== false,
    rateLimit: window !== null && count !== null && count > 0 ? { window, count } : null,
  };
}

/** The filters API returns true/false, or a list of sub-filters (legacy-browsers) where a non-empty list means on. */
export function filterActive(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value === true;
}

function idString(value: unknown, path: string, issues: Issues): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return issues.string(value, path, 100);
}

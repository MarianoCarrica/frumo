/**
 * `frumo sentry --org <slug>`: collects a SentrySnapshot with read-only GETs.
 *
 *   GET /api/0/organizations/:org/projects/                     org:read      project slugs, platforms
 *   GET /api/0/organizations/:org/stats_v2/  (one per category) org:read      volume by project and outcome
 *   GET /api/0/organizations/:org/issues/?query=&sort=freq      event:read    noisiest issues, any status
 *   GET /api/0/projects/:org/:project/filters/  (busiest few)   project:read  built-in inbound filters
 *   GET /api/0/projects/:org/:project/keys/     (busiest few)   project:read  rate limit per client key
 *
 * The client-keys API returns DSNs and the public/secret key. Only the key label, whether it is
 * active and its rate limit are kept; collection fails rather than return a snapshot that
 * contains any of those strings.
 */
import { ApiError } from '../util/errors.js';
import { isRecord } from '../util/validate.js';
import type { SentryReadOnlyClient } from './client.js';
import { SENTRY_SNAPSHOT_SCHEMA, SENTRY_STAT_CATEGORIES, filterActive, isSlug, sanitizeKey } from './snapshot.js';
import type { SentryIssue, SentryProject, SentryProjectConfig, SentryStatCategory, SentryStatRow, SentrySnapshot } from './snapshot.js';

export interface SentryCollectOptions {
  org: string;
  days: number;
  toolVersion: string;
  now?: Date;
  /** How many of the busiest projects get their filters and keys checked. */
  maxProjectsChecked?: number;
  /** Pages of 100 issues to read. */
  issuePages?: number;
  progress?: (line: string) => void;
}

export const DEFAULT_PROJECTS_CHECKED = 5;

export async function collectSentrySnapshot(client: SentryReadOnlyClient, options: SentryCollectOptions): Promise<SentrySnapshot> {
  const progress = options.progress ?? (() => undefined);
  const notes: string[] = [];
  const now = options.now ?? new Date();
  const { org, days } = options;
  if (!isSlug(org)) throw new ApiError(`"${org}" is not a valid organization slug.`, { status: null, path: '(org)' });
  const enc = encodeURIComponent(org);
  /** Strings that must never reach the snapshot (DSNs, key ids, public/secret keys). */
  const secrets = new Set<string>();

  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      const value = await fn();
      progress(`  ✓ ${label}`);
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) throw error;
      const message = error instanceof Error ? error.message : String(error);
      progress(`  ✗ ${label}: ${message}`);
      notes.push(`${label} could not be read: ${message}`);
      return null;
    }
  };

  progress(`Reading Sentry organization "${org}" (last ${days} days, read-only)…`);

  const projects = await step('Projects', async () => {
    const out: SentryProject[] = [];
    let page = await client.get<unknown>(`/api/0/organizations/${enc}/projects/`, { per_page: 100 }, 'org:read');
    for (let i = 0; ; i += 1) {
      for (const p of Array.isArray(page.data) ? page.data : []) {
        if (!isRecord(p)) continue;
        const id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : null;
        const slug = typeof p.slug === 'string' ? p.slug : null;
        if (id && slug) out.push({ id, slug, name: typeof p.name === 'string' ? p.name : null, platform: typeof p.platform === 'string' ? p.platform : null });
      }
      if (!page.next || i >= 4) break;
      page = await client.getNext<unknown>(page.next, 'org:read');
    }
    return out;
  });

  const stats: SentryStatRow[] = [];
  const statsMissing: SentryStatCategory[] = [];
  for (const category of SENTRY_STAT_CATEGORIES) {
    const rows = await step(`Usage stats: ${category}`, async () => {
      const page = await client.get<unknown>(
        `/api/0/organizations/${enc}/stats_v2/`,
        { field: 'sum(quantity)', groupBy: ['project', 'outcome'], category, statsPeriod: `${days}d`, interval: '1d', project: '-1' },
        'org:read',
      );
      return statRows(page.data, category);
    });
    if (rows === null) statsMissing.push(category);
    else stats.push(...rows);
  }

  const issues = await step('Top issues by event count', async () => {
    const out: SentryIssue[] = [];
    const pages = options.issuePages ?? 2;
    let page = await client.get<unknown>(`/api/0/organizations/${enc}/issues/`, { query: '', sort: 'freq', limit: 100, statsPeriod: `${days}d` }, 'event:read');
    for (let i = 1; ; i += 1) {
      for (const raw of Array.isArray(page.data) ? page.data : []) {
        const issue = parseIssue(raw);
        if (issue) out.push(issue);
      }
      if (!page.next || i >= pages) break;
      page = await client.getNext<unknown>(page.next, 'event:read');
    }
    return out;
  });

  // Busiest projects by accepted events (attachments are bytes, so they don't count here).
  const accepted = new Map<string, number>();
  for (const r of stats) if (r.outcome === 'accepted' && r.category !== 'attachment') accepted.set(r.projectId, (accepted.get(r.projectId) ?? 0) + r.quantity);
  const busiest = (projects ?? [])
    .filter((p) => (accepted.get(p.id) ?? 0) > 0)
    .sort((a, b) => (accepted.get(b.id) ?? 0) - (accepted.get(a.id) ?? 0))
    .slice(0, options.maxProjectsChecked ?? DEFAULT_PROJECTS_CHECKED);

  const projectConfigs: SentryProjectConfig[] = [];
  for (const p of busiest) {
    const slug = encodeURIComponent(p.slug);
    const filters = await step(`Inbound filters: ${p.slug}`, async () => {
      const page = await client.get<unknown>(`/api/0/projects/${enc}/${slug}/filters/`, {}, 'project:read');
      return (Array.isArray(page.data) ? page.data : []).flatMap((f) =>
        isRecord(f) && typeof f.id === 'string' ? [{ id: f.id.slice(0, 100), active: filterActive(f.active) }] : [],
      );
    });
    const keys = await step(`Client keys (rate limits only): ${p.slug}`, async () => {
      const page = await client.get<unknown>(`/api/0/projects/${enc}/${slug}/keys/`, {}, 'project:read');
      const list = Array.isArray(page.data) ? page.data : [];
      for (const k of list) collectSecretStrings(k, secrets);
      return list.flatMap((k, i) => (isRecord(k) ? [sanitizeKey(k, i)] : []));
    });
    projectConfigs.push({ projectSlug: p.slug, filters, keys });
  }

  const start = new Date(now.getTime() - days * 86_400_000);
  const snapshot: SentrySnapshot = {
    schema: SENTRY_SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    source: { kind: 'live', host: client.origin, toolVersion: options.toolVersion, fictional: false, label: null },
    org: { slug: org, name: null },
    period: { days, start: start.toISOString(), end: now.toISOString() },
    stats: statsMissing.length === SENTRY_STAT_CATEGORIES.length ? null : stats,
    statsMissing,
    projects,
    issues,
    projectConfigs,
    notes,
  };
  assertNoSecrets(snapshot, secrets);
  progress(`Done: ${client.requestCount} read-only requests.`);
  return snapshot;
}

/** stats_v2 response → rows. Groups look like { by: { project, outcome }, totals: { "sum(quantity)": n } }. */
export function statRows(data: unknown, category: SentryStatCategory): SentryStatRow[] {
  if (!isRecord(data) || !Array.isArray(data.groups)) throw new ApiError('stats_v2: unexpected response shape from Sentry', { status: null, path: 'stats_v2' });
  const out: SentryStatRow[] = [];
  for (const g of data.groups) {
    if (!isRecord(g) || !isRecord(g.by) || !isRecord(g.totals)) continue;
    const project = g.by.project;
    const outcome = g.by.outcome;
    const quantity = g.totals['sum(quantity)'];
    if ((typeof project !== 'number' && typeof project !== 'string') || typeof outcome !== 'string' || typeof quantity !== 'number' || !Number.isFinite(quantity)) continue;
    if (quantity <= 0) continue;
    out.push({ projectId: String(project), category, outcome, quantity });
  }
  return out;
}

export function parseIssue(raw: unknown): SentryIssue | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : null;
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 2_000) : null;
  const count = typeof raw.count === 'number' ? raw.count : typeof raw.count === 'string' && /^\d+$/.test(raw.count) ? Number(raw.count) : null;
  if (!id || !title || count === null) return null;
  const project = isRecord(raw.project) ? raw.project : {};
  const str = (v: unknown, max = 2_000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
  return {
    id,
    shortId: str(raw.shortId, 100),
    title,
    culprit: str(raw.culprit),
    count,
    status: str(raw.status, 50) ?? 'unresolved',
    substatus: str(raw.substatus, 100),
    projectSlug: str(project.slug, 100),
    level: str(raw.level, 50),
  };
}

/** Gathers the secret-bearing strings of a raw client-key object: its id (the public key), public, secret and every DSN. */
function collectSecretStrings(raw: unknown, into: Set<string>): void {
  if (!isRecord(raw)) return;
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length >= 8) into.add(v);
    else if (isRecord(v)) for (const inner of Object.values(v)) add(inner);
  };
  add(raw.id);
  add(raw.public);
  add(raw.secret);
  add(raw.dsn);
}

/** Last line of defence: refuse to return a snapshot that contains a DSN or key string. */
export function assertNoSecrets(snapshot: SentrySnapshot, secrets: ReadonlySet<string>): void {
  const text = JSON.stringify(snapshot);
  for (const s of secrets) {
    if (text.includes(s)) throw new Error('Refusing to build a Sentry snapshot that contains a client key or DSN.');
  }
}

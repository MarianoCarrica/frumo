/**
 * `frumo sentry` analysis: Sentry snapshot → estimated bill, drivers, ranked fixes and snippets.
 *
 * Costs: accepted volume per 30-day month, minus the plan's included volume, through Sentry's
 * public pay-as-you-go bands (src/pricing/public-pricing.ts). Savings: the bill today minus the
 * bill with the fix's volume removed, at the same bands.
 */
import { tieredCost } from '../pricing/math.js';
import { SENTRY_PUBLIC_PRICING } from '../pricing/public-pricing.js';
import { SENTRY_BILLED_CATEGORIES } from '../pricing/types.js';
import type { SentryBilledCategory, SentryPlan } from '../pricing/types.js';
import { count, usd } from '../report/format.js';
import type { SentryAuditResult, SentryCostLine, SentryDriver, SentryEffect, SentryFix, SentryIssueRow, SentryProjectRow, SentryVolumes } from './model.js';
import { beforeSendSnippet, errorSampleRateSnippet, ignoreErrorsSnippet, matchText, tracesSampleRateSnippet } from './snippets.js';
import type { DropTarget } from './snippets.js';
import type { SentryIssue, SentryProject, SentrySnapshot, SentryStatCategory } from './snapshot.js';

export interface SentryAnalysisOptions {
  toolVersion: string;
  plan: SentryPlan;
  now?: Date;
}

export const SENTRY_DISCLAIMER =
  "Estimates only. frumo is unofficial and not affiliated with or endorsed by Functional Software, Inc. (Sentry). Dollar figures apply Sentry's public pay-as-you-go list prices for the plan shown to the accepted volume in your data, normalized to a 30-day month. This is not your invoice: the plan fee, reserved volume, mid-cycle plan changes, credits and Enterprise contracts all differ. Review every change before shipping it.";

export const SENTRY_DOCS = {
  quotas: { title: 'Quota management (ignored issues still count)', url: 'https://docs.sentry.io/pricing/quotas/' },
  filtering: { title: 'Inbound data filters', url: 'https://docs.sentry.io/concepts/data-management/filtering/' },
  eventStream: { title: 'Manage your event stream', url: 'https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/' },
  spike: { title: 'Spike protection', url: 'https://docs.sentry.io/pricing/quotas/spike-protection/' },
  sdkFiltering: { title: 'Filtering events in the JavaScript SDK', url: 'https://docs.sentry.io/platforms/javascript/configuration/filtering/' },
  sampling: { title: 'Sampling in the JavaScript SDK', url: 'https://docs.sentry.io/platforms/javascript/configuration/sampling/' },
} as const;

/** stats_v2 category → billing category. Transactions are treated as billable spans (see notes). */
const BILLED_FOR: Record<SentryStatCategory, SentryBilledCategory> = { error: 'errors', transaction: 'spans', replay: 'replays', attachment: 'attachments' };
/** Attachments are reported in bytes and billed per GB (decimal). */
const BYTES_PER_GB = 1_000_000_000;

/** Built-in inbound filters that are safe to switch on; available on every plan. */
const SAFE_FILTERS: Record<string, { label: string; drops: string; browserOnly: boolean; needsTransactions: boolean }> = {
  'browser-extensions': { label: 'Browser extension errors', drops: 'errors thrown inside browser extensions', browserOnly: true, needsTransactions: false },
  'web-crawlers': { label: 'Web crawlers', drops: 'events from known crawlers', browserOnly: true, needsTransactions: false },
  localhost: { label: 'Events from localhost', drops: 'events from local development', browserOnly: false, needsTransactions: false },
  'filtered-transaction': { label: 'Health check transactions', drops: 'health-check transactions', browserOnly: false, needsTransactions: true },
};

const EXTENSION_URL = /\b(?:chrome|moz|safari(?:-web)?|ms-browser)-extension:\/\//i;
/** Noisy-issue threshold: an unresolved issue sending at least this share of accepted errors. */
const NOISY_SHARE = 0.05;
const MAX_NOISY = 3;
const MAX_ISSUES_SHOWN = 10;
/** Suggest tracing/error sampling only when that line costs at least this much per month. */
const TRACES_SAMPLING_MIN_USD = 50;
const ERROR_SAMPLING_MIN_USD = 500;

export function emptyVolumes(): SentryVolumes {
  return { errors: null, spans: null, replays: null, attachments: null };
}

export function categoryCost(category: SentryBilledCategory, units: number, plan: SentryPlan): number {
  return tieredCost(units, SENTRY_PUBLIC_PRICING.categories[category].tiers[plan]);
}

export function totalCost(volumes: SentryVolumes, plan: SentryPlan): number {
  return SENTRY_BILLED_CATEGORIES.reduce((sum, c) => sum + (volumes[c] === null ? 0 : categoryCost(c, volumes[c], plan)), 0);
}

/** Applies effects: absolute removals first, then fractions of what is left. */
export function applyEffects(volumes: SentryVolumes, effects: readonly SentryEffect[]): SentryVolumes {
  const out = { ...volumes };
  const ordered = [...effects.filter((e) => e.removeUnits !== undefined), ...effects.filter((e) => e.removeUnits === undefined)];
  for (const e of ordered) {
    const v = out[e.category];
    if (v === null) continue;
    let next = v;
    if (e.removeUnits !== undefined) next = Math.max(0, next - e.removeUnits);
    if (e.removeFraction !== undefined) next = next * (1 - Math.min(1, Math.max(0, e.removeFraction)));
    out[e.category] = next;
  }
  return out;
}

function isBrowserPlatform(platform: string | null): boolean {
  return platform === null || platform === 'javascript' || platform.startsWith('javascript-');
}

/** Platforms whose SDK takes the JavaScript Sentry.init snippets as-is. */
function isJsPlatform(platform: string | null): boolean {
  return platform === null || /^(javascript|node|react-native|electron|bun|deno)(-|$)/.test(platform);
}

function isIgnored(issue: SentryIssue): boolean {
  return issue.status === 'ignored' || issue.status === 'archived' || (issue.substatus ?? '').startsWith('archived');
}

export function runSentryAnalysis(snap: SentrySnapshot, options: SentryAnalysisOptions): SentryAuditResult {
  const { plan } = options;
  const pricing = SENTRY_PUBLIC_PRICING;
  const scale = 30 / snap.period.days;
  const notes = [...snap.notes];
  const findings: SentryAuditResult['findings'] = [];
  const notEstimated = [
    'Logs, metrics, profiling, Seer, cron monitors and uptime monitors: not estimated in this version.',
    `The ${plan === 'team' ? 'Team' : 'Business'} plan subscription fee: not included; the figures are pay-as-you-go volume above the included quota.`,
  ];
  const projectsById = new Map<string, SentryProject>((snap.projects ?? []).map((p) => [p.id, p]));
  const projectsBySlug = new Map<string, SentryProject>((snap.projects ?? []).map((p) => [p.slug, p]));

  // Monthly volume by category and outcome, org-wide and per project.
  const accepted: SentryVolumes = emptyVolumes();
  const dropped: Record<SentryBilledCategory, { filtered: number; rateLimited: number; other: number }> = {
    errors: { filtered: 0, rateLimited: 0, other: 0 },
    spans: { filtered: 0, rateLimited: 0, other: 0 },
    replays: { filtered: 0, rateLimited: 0, other: 0 },
    attachments: { filtered: 0, rateLimited: 0, other: 0 },
  };
  const perProject = new Map<string, SentryVolumes>();
  if (snap.stats !== null) {
    for (const stat of ['error', 'transaction', 'replay', 'attachment'] as const) {
      if (!snap.statsMissing.includes(stat)) accepted[BILLED_FOR[stat]] = 0;
    }
    for (const row of snap.stats) {
      const cat = BILLED_FOR[row.category];
      const units = (row.category === 'attachment' ? row.quantity / BYTES_PER_GB : row.quantity) * scale;
      if (row.outcome === 'accepted') {
        accepted[cat] = (accepted[cat] ?? 0) + units;
        const pv = perProject.get(row.projectId) ?? { errors: 0, spans: 0, replays: 0, attachments: 0 };
        pv[cat] = (pv[cat] ?? 0) + units;
        perProject.set(row.projectId, pv);
      } else if (row.outcome === 'filtered') dropped[cat].filtered += units;
      else if (row.outcome === 'rate_limited') dropped[cat].rateLimited += units;
      else dropped[cat].other += units;
    }
  } else {
    notes.push('No usage stats in the data, so there is no bill estimate. The token needs org:read for stats_v2.');
  }
  for (const stat of snap.statsMissing) notEstimated.push(`${pricing.categories[BILLED_FOR[stat]].label}: usage stats could not be read, so not in the total.`);

  const lines: SentryCostLine[] = SENTRY_BILLED_CATEGORIES.map((c) => {
    const p = pricing.categories[c];
    const units = accepted[c];
    return {
      category: c,
      label: p.label,
      unitPlural: p.unitPlural,
      accepted: units,
      filtered: dropped[c].filtered,
      rateLimited: dropped[c].rateLimited,
      otherDropped: dropped[c].other,
      included: p.included,
      usd: units === null ? null : categoryCost(c, units, plan),
    };
  });
  const base = totalCost(accepted, plan);
  const errorsTotal = accepted.errors ?? 0;
  const errorCostWithout = (units: number): number | null =>
    accepted.errors === null ? null : categoryCost('errors', errorsTotal, plan) - categoryCost('errors', Math.max(0, errorsTotal - units), plan);

  // Issues: classify each into at most one fix (ignored > browser extension > noisy).
  const configs = new Map(snap.projectConfigs.map((c) => [c.projectSlug, c]));
  const filterOff = (slug: string | null, id: string): boolean => {
    const filters = slug ? configs.get(slug)?.filters : null;
    return !!filters && filters.some((f) => f.id === id && !f.active);
  };
  const issues = [...(snap.issues ?? [])].sort((a, b) => b.count - a.count);
  const fixOf = new Map<string, string>();
  const ignored = issues.filter((i) => i.count > 0 && isIgnored(i));
  for (const i of ignored) fixOf.set(i.id, 'drop-ignored-issues');
  const extension = issues.filter((i) => !fixOf.has(i.id) && i.count > 0 && EXTENSION_URL.test(`${i.culprit ?? ''} ${i.title}`) && filterOff(i.projectSlug, 'browser-extensions'));
  for (const i of extension) fixOf.set(i.id, `inbound-filters:${i.projectSlug ?? ''}`);
  const noisyMin = accepted.errors !== null && accepted.errors > 0 ? accepted.errors * NOISY_SHARE : 0;
  const noisy = issues
    .filter((i) => !fixOf.has(i.id) && i.status === 'unresolved' && i.count * scale >= noisyMin && i.count > 0)
    .slice(0, MAX_NOISY);
  for (const i of noisy) fixOf.set(i.id, 'drop-noisy-issues');

  const platformOf = (i: SentryIssue): string | null => (i.projectSlug ? (projectsBySlug.get(i.projectSlug)?.platform ?? null) : null);
  const target = (i: SentryIssue, status: string): DropTarget => ({
    match: matchText(i.title),
    note: `${i.projectSlug ?? 'project?'} · ${status} · ${count(i.count * scale)}/mo`,
  });
  const fixes: SentryFix[] = [];
  const teamCaveat =
    'On Team, Delete & Discard and inbound filters by error message, release or IP are not available (they need Business or Enterprise), so the client-side filter is the way to stop these events.';
  const businessOption =
    'On Business you can also stop them server-side without a redeploy: Delete & Discard the issue, or add an inbound filter by error message (Project Settings > Inbound Filters).';

  if (ignored.length > 0) {
    const units = Math.min(errorsTotal, ignored.reduce((s, i) => s + i.count * scale, 0));
    const jsIssues = ignored.filter((i) => isJsPlatform(platformOf(i)));
    const other = ignored.filter((i) => !isJsPlatform(platformOf(i)));
    const targets = jsIssues.map((i) => target(i, 'ignored'));
    fixes.push({
      id: 'drop-ignored-issues',
      title: `Stop sending ${ignored.length} ignored ${ignored.length === 1 ? 'issue' : 'issues'} that still bill`,
      kind: 'no-regret',
      effects: [{ category: 'errors', removeUnits: units }],
      evidence: `${ignored.length} issue${ignored.length === 1 ? ' is' : 's are'} ignored/archived in Sentry but still sent ${count(units)} errors/mo. Ignoring an issue hides it; its events still count toward your quota.`,
      assumption: `The issue event counts are accepted errors. Saving = your error bill now minus the bill with ${count(units)} fewer errors, through the ${plan === 'team' ? 'Team' : 'Business'} PAYG bands at your current volume.`,
      youLose: "Nothing you were looking at: these issues are already ignored. If one of them gets worse, Sentry won't see it.",
      steps: [
        'Add the ignoreErrors list (or the beforeSend filter) to Sentry.init where these errors come from, then redeploy.',
        ...other.map((i) => `"${matchText(i.title)}" comes from ${i.projectSlug ?? 'a project'} (${platformOf(i) ?? 'unknown platform'}): drop it in that SDK's before_send.`),
        plan === 'team' ? teamCaveat : businessOption,
      ],
      snippets: targets.length > 0 ? [ignoreErrorsSnippet(targets), beforeSendSnippet(targets)] : [],
      docs: [SENTRY_DOCS.quotas, SENTRY_DOCS.sdkFiltering, SENTRY_DOCS.eventStream],
      savingUsd: errorCostWithout(units),
    });
  }

  // Built-in inbound filters left off, per checked project.
  const projectRows: SentryProjectRow[] = [];
  for (const cfg of snap.projectConfigs) {
    const project = projectsBySlug.get(cfg.projectSlug) ?? null;
    const platform = project?.platform ?? null;
    const volumes = project ? perProject.get(project.id) : undefined;
    const off = (cfg.filters ?? []).filter((f) => !f.active && f.id in SAFE_FILTERS).map((f) => f.id);
    const recommended = off.filter((id) => {
      const meta = SAFE_FILTERS[id];
      if (!meta) return false;
      if (meta.browserOnly && !isBrowserPlatform(platform)) return false;
      if (meta.needsTransactions && !((volumes?.spans ?? 0) > 0)) return false;
      return true;
    });
    if (recommended.length === 0) continue;
    const covered = extension.filter((i) => i.projectSlug === cfg.projectSlug && recommended.includes('browser-extensions'));
    const units = Math.min(errorsTotal, covered.reduce((s, i) => s + i.count * scale, 0));
    const names = recommended.map((id) => `${SAFE_FILTERS[id]?.label ?? id} (${id})`);
    fixes.push({
      id: `inbound-filters:${cfg.projectSlug}`,
      title: `Turn on built-in inbound filters in ${cfg.projectSlug}`,
      kind: 'no-regret',
      effects: units > 0 ? [{ category: 'errors', removeUnits: units }] : [],
      evidence:
        covered.length > 0
          ? `Off: ${names.join(', ')}. ${covered.length} issue${covered.length === 1 ? '' : 's'} from browser extensions sent ${count(units)} errors/mo (e.g. "${matchText(covered[0]?.title ?? '')}").`
          : `Off: ${names.join(', ')}. frumo can't see how many events they would drop; filtered events are not billed.`,
      assumption:
        covered.length > 0
          ? 'Only the browser-extension issues frumo could attribute are counted; the other filters may save more. Priced through the PAYG bands at your current error volume.'
          : 'No dollar estimate: the volume these filters would catch is not visible through the API until they are on (then it shows as "filtered" in Stats).',
      youLose: `Events you almost never act on: ${recommended.map((id) => SAFE_FILTERS[id]?.drops ?? id).join(', ')}.`,
      steps: [
        `In Sentry: ${cfg.projectSlug} > Project Settings > Inbound Filters, switch on: ${recommended.join(', ')}. These built-in filters are available on every plan and need no redeploy.`,
        plan === 'team'
          ? 'Custom inbound filters (by error message, release or IP address) are Business/Enterprise (and Trial) only, so they are not suggested here.'
          : 'On Business you can also add custom filters by error message, release or IP address on the same page.',
      ],
      snippets: [],
      docs: [SENTRY_DOCS.filtering, SENTRY_DOCS.eventStream],
      savingUsd: units > 0 ? errorCostWithout(units) : null,
    });
  }

  if (noisy.length > 0) {
    const units = Math.min(errorsTotal, noisy.reduce((s, i) => s + i.count * scale, 0));
    const targets = noisy.filter((i) => isJsPlatform(platformOf(i))).map((i) => target(i, 'unresolved'));
    fixes.push({
      id: 'drop-noisy-issues',
      title: `Fix or drop the ${noisy.length} noisiest unresolved ${noisy.length === 1 ? 'issue' : 'issues'}`,
      kind: 'trade-off',
      effects: [{ category: 'errors', removeUnits: units }],
      evidence: `${noisy.map((i) => `"${matchText(i.title)}" (${count(i.count * scale)}/mo)`).join(', ')}: each sends at least ${Math.round(NOISY_SHARE * 100)}% of your accepted errors.`,
      assumption: `Best fix is the bug itself. If an issue is known noise, dropping it client-side removes ${count(units)} errors/mo, priced through the PAYG bands at your current volume.`,
      youLose: "If you drop rather than fix: you stop seeing these errors in Sentry, including if they get worse.",
      steps: ['Fix the root cause where you can. For known noise, add it to the beforeSend list below and redeploy.', plan === 'team' ? teamCaveat : businessOption],
      snippets: targets.length > 0 ? [beforeSendSnippet(targets)] : [],
      docs: [SENTRY_DOCS.sdkFiltering, SENTRY_DOCS.eventStream],
      savingUsd: errorCostWithout(units),
    });
  }

  // Sampling, only when the volume justifies it.
  const spanCost = accepted.spans === null ? 0 : categoryCost('spans', accepted.spans, plan);
  if (spanCost >= TRACES_SAMPLING_MIN_USD && accepted.spans !== null) {
    const after = categoryCost('spans', accepted.spans / 2, plan);
    fixes.push({
      id: 'traces-sample-rate',
      title: 'Halve tracesSampleRate in the busiest services',
      kind: 'trade-off',
      effects: [{ category: 'spans', removeFraction: 0.5 }],
      evidence: `${count(accepted.spans)} spans/mo cost about ${usd(spanCost)}/mo after the ${count(pricing.categories.spans.included)} included.`,
      assumption: 'Halving the sample rate halves accepted spans. frumo does not know your current rate; the snippet shows 0.1 as an example.',
      youLose: 'Some traces: rare slow requests are less likely to be captured. Needs a redeploy.',
      steps: ['Halve tracesSampleRate (or return lower rates from tracesSampler for health checks and chatty routes), then redeploy.'],
      snippets: [tracesSampleRateSnippet(0.1)],
      docs: [SENTRY_DOCS.sampling],
      savingUsd: spanCost - after,
    });
  }
  const afterIssueFixes = applyEffects(accepted, fixes.flatMap((f) => f.effects));
  const errorCostLeft = afterIssueFixes.errors === null ? 0 : categoryCost('errors', afterIssueFixes.errors, plan);
  if (errorCostLeft >= ERROR_SAMPLING_MIN_USD && accepted.errors !== null) {
    fixes.push({
      id: 'error-sample-rate',
      title: 'Sample errors (sampleRate 0.5) as a last resort',
      kind: 'trade-off',
      effects: [{ category: 'errors', removeFraction: 0.5 }],
      evidence: `Even after the issue fixes above, about ${count(afterIssueFixes.errors ?? 0)} errors/mo cost ${usd(errorCostLeft)}/mo.`,
      assumption: 'sampleRate 0.5 halves the errors left after the issue fixes above; saving is priced on that remaining volume.',
      youLose: 'Half of every error, including rare and new ones; event and user counts in Sentry become estimates. Needs a redeploy.',
      steps: ['Only if the issue-level fixes are not enough: set sampleRate in Sentry.init and redeploy.'],
      snippets: [errorSampleRateSnippet(0.5)],
      docs: [SENTRY_DOCS.sampling, SENTRY_DOCS.eventStream],
      savingUsd: errorCostLeft - categoryCost('errors', (afterIssueFixes.errors ?? 0) / 2, plan),
    });
  }

  // Rate limits and spike protection.
  const keysWithout = snap.projectConfigs.flatMap((c) => (c.keys ?? []).filter((k) => k.isActive && k.rateLimit === null).map((k) => ({ project: c.projectSlug, label: k.label })));
  if (keysWithout.length > 0) {
    const where = [...new Set(keysWithout.map((k) => k.project))].join(', ');
    if (plan === 'business') {
      fixes.push({
        id: 'key-rate-limits',
        title: 'Set rate limits on client keys (DSNs) without one',
        kind: 'trade-off',
        effects: [],
        evidence: `${keysWithout.length} active client key${keysWithout.length === 1 ? ' has' : 's have'} no rate limit (${where}).`,
        assumption: 'No dollar estimate: a rate limit caps bursts (a loop, a bad deploy); it does not change normal volume.',
        youLose: 'Events above the limit are dropped during a burst.',
        steps: [`In Sentry: Project Settings > Client Keys (DSN) > Configure > Rate Limit, for ${where}.`],
        snippets: [],
        docs: [SENTRY_DOCS.eventStream],
        savingUsd: null,
      });
    } else {
      findings.push({
        level: 'info',
        text: `${keysWithout.length} active client key${keysWithout.length === 1 ? ' has' : 's have'} no rate limit (${where}). Per-key (DSN) rate limits are Business/Enterprise only, so on Team rely on spike protection and the SDK options above.`,
      });
    }
  }
  findings.push({
    level: 'info',
    text: 'Spike protection covers errors, spans/transactions and attachments, not replays. Check it is on in Settings > Spike Protection; frumo never reads or changes it. Docs: https://docs.sentry.io/pricing/quotas/spike-protection/',
  });
  const limited = lines.filter((l) => l.rateLimited > 0);
  if (limited.length > 0) {
    findings.push({
      level: 'info',
      text: `Sentry dropped ${limited.map((l) => `${count(l.rateLimited)} ${l.unitPlural}`).join(', ')} per month as rate_limited (spike protection, quotas or key limits). Those were not billed, but they were not stored either.`,
    });
  }
  const filteredLines = lines.filter((l) => l.filtered > 0);
  if (filteredLines.length > 0) {
    findings.push({ level: 'info', text: `Inbound filters already drop ${filteredLines.map((l) => `${count(l.filtered)} ${l.unitPlural}`).join(', ')} per month for free.` });
  }
  if (snap.projectConfigs.length === 0 && snap.stats !== null) notEstimated.push('Inbound filters and client keys: no project settings in the data.');
  if (snap.issues === null) notEstimated.push('Issues: not readable (the token needs event:read), so no issue-level fixes.');

  if ((accepted.spans ?? 0) > 0) {
    notes.push(
      "Tracing volume comes from Sentry's transaction category and is priced as one span per transaction. If your organization is billed on spans, each transaction usually holds several spans, so the spans line is a lower bound.",
    );
  }
  if (plan === 'team') {
    notes.push(
      'Plan: Team (--plan business to compare). Custom inbound filters, filters by error message/release/IP, Delete & Discard and per-key rate limits need Business or Enterprise, so they are not suggested.',
    );
  }
  if (snap.source.fictional) notes.unshift('Demo data: a fictional organization. No real Sentry account was contacted.');

  // Rank fixes by saving; unknown savings last, no-regret first on ties.
  fixes.sort((a, b) => (b.savingUsd ?? -1) - (a.savingUsd ?? -1) || (a.kind === 'no-regret' ? -1 : 1) - (b.kind === 'no-regret' ? -1 : 1));
  const afterAll = totalCost(applyEffects(accepted, fixes.flatMap((f) => f.effects)), plan);
  const afterNoRegret = totalCost(applyEffects(accepted, fixes.filter((f) => f.kind === 'no-regret').flatMap((f) => f.effects)), plan);
  const allUsd = Math.max(0, base - afterAll);
  const noRegretUsd = Math.max(0, base - afterNoRegret);

  // Projects and drivers: share of each category's cost at the average rate.
  const avg = (c: SentryBilledCategory): number => {
    const units = accepted[c];
    const line = lines.find((l) => l.category === c);
    return units && line?.usd ? line.usd / units : 0;
  };
  const drivers: SentryDriver[] = [];
  const projectIds = new Set<string>([...perProject.keys(), ...(snap.projects ?? []).map((p) => p.id)]);
  for (const id of projectIds) {
    const p = projectsById.get(id) ?? null;
    const v = perProject.get(id) ?? { errors: 0, spans: 0, replays: 0, attachments: 0 };
    const cfg = p ? configs.get(p.slug) : undefined;
    let cost = 0;
    for (const c of SENTRY_BILLED_CATEGORIES) {
      const units = v[c] ?? 0;
      if (units <= 0) continue;
      cost += units * avg(c);
      drivers.push({ title: `${p?.slug ?? `project ${id}`}: ${pricing.categories[c].label.toLowerCase()}`, category: c, units, unitPlural: pricing.categories[c].unitPlural, costUsd: units * avg(c) });
    }
    projectRows.push({
      id,
      slug: p?.slug ?? id,
      name: p?.name ?? null,
      platform: p?.platform ?? null,
      accepted: v,
      costUsd: snap.stats === null ? null : cost,
      checked: !!cfg,
      filtersOff: (cfg?.filters ?? []).filter((f) => !f.active).map((f) => f.id),
      keysWithoutRateLimit: cfg?.keys ? cfg.keys.filter((k) => k.isActive && k.rateLimit === null).length : null,
    });
  }
  projectRows.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || (b.accepted.errors ?? 0) - (a.accepted.errors ?? 0));
  drivers.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.units - a.units);

  const issueRows: SentryIssueRow[] = issues.slice(0, MAX_ISSUES_SHOWN).map((i, idx) => ({
    rank: idx + 1,
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit,
    projectSlug: i.projectSlug,
    status: i.substatus && isIgnored(i) ? `${i.status} (${i.substatus})` : i.status,
    eventsPerMonth: i.count * scale,
    estUsd: errorCostWithout(Math.min(errorsTotal, i.count * scale)),
    ignoredButBilled: isIgnored(i) && i.count > 0,
    fixId: fixOf.get(i.id) ?? null,
  }));

  return {
    schema: 'frumo.sentry-report/v1',
    tool: { name: 'frumo', version: options.toolVersion },
    generatedAt: (options.now ?? new Date()).toISOString(),
    input: {
      sourceKind: snap.source.kind,
      label: snap.source.label,
      fictional: snap.source.fictional,
      host: snap.source.host,
      org: snap.org.slug,
      periodDays: snap.period.days,
      periodStart: snap.period.start,
      periodEnd: snap.period.end,
      plan,
    },
    pricing: { name: pricing.name, sources: pricing.sources, retrieved: pricing.retrieved, plan },
    costs: { lines, totalUsd: base, anyKnown: lines.some((l) => l.usd !== null) },
    savings: { allUsd, noRegretUsd, allPct: base > 0 ? allUsd / base : 0, noRegretPct: base > 0 ? noRegretUsd / base : 0 },
    drivers: drivers.slice(0, 8),
    projects: projectRows,
    issues: issueRows,
    fixes,
    findings,
    notEstimated,
    notes,
    disclaimer: SENTRY_DISCLAIMER,
  };
}

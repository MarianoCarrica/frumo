import { usd } from '../report/format.js';
import type { ProductKey } from '../pricing/types.js';
import { PRODUCT_KEYS } from '../pricing/types.js';
import type { Snapshot, Usage } from '../snapshot.js';
import { analyzeAutocapture } from './analyzers/autocapture.js';
import { analyzeBots } from './analyzers/bots.js';
import { analyzeDevHosts } from './analyzers/dev-hosts.js';
import { analyzeTopEvents } from './analyzers/events.js';
import { analyzeFlags } from './analyzers/flags.js';
import { analyzeIdentity } from './analyzers/identity.js';
import { analyzeOtherProducts } from './analyzers/other-products.js';
import { analyzePageviews } from './analyzers/pageviews.js';
import { analyzePersonProfiles } from './analyzers/person-profiles.js';
import { analyzeReplay } from './analyzers/replay.js';
import { analyzeServerEvents } from './analyzers/server-events.js';
import { analyzeStaging } from './analyzers/staging.js';
import { AnalysisContext, looksLikeStagingProject } from './context.js';
import type { AnalysisOptions, AnalyzerOutput } from './context.js';
import { applyEffects, costBreakdown, savingBetween } from './costs.js';
import type { AuditResult, BillingLimitSuggestion, CostBreakdown, Driver, FixResult } from './model.js';
import { buildInitDiff } from './snippets.js';
import type { UrlClass } from './url-class.js';

export type { AnalysisOptions } from './context.js';

export const ANALYZERS: ReadonlyArray<(ctx: AnalysisContext) => AnalyzerOutput> = [
  analyzeTopEvents,
  analyzeAutocapture,
  analyzePageviews,
  analyzeIdentity,
  analyzePersonProfiles,
  analyzeServerEvents,
  analyzeBots,
  analyzeDevHosts,
  analyzeStaging,
  analyzeReplay,
  analyzeFlags,
  analyzeOtherProducts,
];

export const DISCLAIMER =
  'Estimates only. HogPost is unofficial and not affiliated with or endorsed by PostHog Inc. Dollar figures apply the price list shown above to the usage in your data, normalized to a 30-day month; your invoice can differ (discounts, credits, annual plans, billing-period timing, products not estimated here). Review every change before shipping it.';

const MAX_DRIVERS = 12;

export function runAnalysis(snap: Snapshot, options: AnalysisOptions): AuditResult {
  const ctx = new AnalysisContext(snap, options);
  const outputs = ANALYZERS.map((analyze) => analyze(ctx));

  const fixes: FixResult[] = outputs
    .flatMap((o) => o.fixes)
    .map((fix) => {
      const result = savingBetween(ctx.org, applyEffects(ctx.org, fix.effects), ctx.pricing);
      return { ...fix, savingUsd: result.savingUsd, savingPartial: result.partial, unitsRemoved: result.unitsRemoved };
    })
    .sort((a, b) => (b.savingUsd ?? -1) - (a.savingUsd ?? -1) || (a.kind === 'no-regret' ? -1 : 1) - (b.kind === 'no-regret' ? -1 : 1));

  const base = ctx.baseCost;
  const afterAllUsage = fixes.reduce<Usage>((usage, fix) => applyEffects(usage, fix.effects), ctx.org);
  const afterNoRegretUsage = fixes.filter((f) => f.kind === 'no-regret').reduce<Usage>((usage, fix) => applyEffects(usage, fix.effects), ctx.org);
  const afterAll = costBreakdown(afterAllUsage, ctx.pricing);
  const afterNoRegret = costBreakdown(afterNoRegretUsage, ctx.pricing);

  const seen = new Set<string>();
  const drivers: Driver[] = outputs
    .flatMap((o) => o.drivers)
    .filter((d) => {
      if (seen.has(d.id) || d.units <= 0) return false;
      seen.add(d.id);
      return true;
    })
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.units - a.units)
    .slice(0, MAX_DRIVERS);

  const projectIds = new Set<string>();
  const projects = (snap.orgUsage ?? [])
    .filter((p) => (projectIds.has(p.projectId) ? false : (projectIds.add(p.projectId), true)))
    .map((p) => ({ id: p.projectId, name: p.name, audited: p.audited || p.projectId === snap.project.id, staging: looksLikeStagingProject(p.name) }));

  const notes = [...snap.notes, ...ctx.notes];
  if (ctx.scope === 'project') {
    notes.push(
      'Costs assume this project is your whole PostHog organization (no organization usage in the data). Usage and free allowances are shared across all projects, so other projects would raise the bill and change the tiers.',
    );
  }
  if (snap.source.fictional) notes.unshift('Demo data: a fictional company. No real PostHog account was contacted.');

  const notAnalyzed = outputs.flatMap((o) => o.notAnalyzed);
  for (const line of base.lines) {
    if (line.missing === 'usage-unknown' && (line.usageKey === 'flagRequests' || line.usageKey === 'recordings')) {
      const text = `${line.label}: usage unknown, so it is not in the total.`;
      if (!notAnalyzed.includes(text)) notAnalyzed.push(text);
    }
  }

  const unverified = PRODUCT_KEYS.filter((k) => ctx.pricing.table.products[k].tiers === null);
  for (const key of unverified) {
    const p = ctx.pricing.table.products[key];
    notes.push(`No verified price for ${p.label}${p.unverifiedReason ? ` (${p.unverifiedReason})` : ''}: volumes are shown without a dollar estimate.`);
  }

  return {
    schema: 'hogpost.report/v1',
    tool: { name: 'hogpost', version: options.toolVersion },
    generatedAt: (options.now ?? new Date()).toISOString(),
    input: {
      sourceKind: snap.source.kind,
      label: snap.source.label,
      fictional: snap.source.fictional,
      host: snap.source.host,
      projectId: snap.project.id,
      projectName: snap.project.name,
      periodDays: snap.period.days,
      periodStart: snap.period.start,
      periodEnd: snap.period.end,
      scope: ctx.scope,
      projects,
    },
    pricing: { table: ctx.pricing.table, sources: ctx.pricing.sources, unverified },
    usage: { org: ctx.org, project: ctx.project },
    costs: base,
    billingApi: snap.billing ? { projectedTotalUsd: snap.billing.projectedTotalUsd, currentTotalUsd: snap.billing.currentTotalUsd } : null,
    savings: {
      allUsd: Math.max(0, base.totalUsd - afterAll.totalUsd),
      noRegretUsd: Math.max(0, base.totalUsd - afterNoRegret.totalUsd),
      allPct: base.totalUsd > 0 ? Math.max(0, base.totalUsd - afterAll.totalUsd) / base.totalUsd : 0,
      noRegretPct: base.totalUsd > 0 ? Math.max(0, base.totalUsd - afterNoRegret.totalUsd) / base.totalUsd : 0,
      costAfterAllUsd: afterAll.totalUsd,
      costAfterNoRegretUsd: afterNoRegret.totalUsd,
    },
    drivers,
    fixes,
    initDiff: buildInitDiff(fixes, ctx),
    billingLimits: billingLimits(ctx, base, afterNoRegret, afterAll),
    urlClasses: urlClasses(ctx),
    findings: outputs.flatMap((o) => o.findings),
    notAnalyzed,
    notes,
    disclaimer: DISCLAIMER,
  };
}

/** Rounds a dollar amount up to a tidy limit: $10 steps to $100, $50 to $1k, $250 to $10k, then $1k. */
export function niceLimit(value: number): number {
  if (value <= 0) return 0;
  const step = value <= 100 ? 10 : value <= 1_000 ? 50 : value <= 10_000 ? 250 : 1_000;
  return Math.ceil(value / step) * step;
}

const LIMIT_HEADROOM = 1.3;

function billingLimits(ctx: AnalysisContext, base: CostBreakdown, afterNoRegret: CostBreakdown, afterAll: CostBreakdown): BillingLimitSuggestion[] {
  // PostHog sets billing limits per product; person profiles are billed with product analytics.
  const groups: Array<{ product: ProductKey; label: string; members: ProductKey[] }> = [
    { product: 'product_analytics', label: 'Product analytics (events + person profiles)', members: ['product_analytics', 'identified_events'] },
    { product: 'session_replay', label: 'Session replay', members: ['session_replay', 'mobile_replay'] },
    { product: 'feature_flags', label: 'Feature flags & experiments', members: ['feature_flags'] },
    { product: 'surveys', label: 'Surveys', members: ['surveys'] },
    { product: 'error_tracking', label: 'Error tracking', members: ['error_tracking'] },
  ];
  const sum = (breakdown: CostBreakdown, members: ProductKey[]): { usd: number | null; units: number } => {
    let total: number | null = null;
    let units = 0;
    for (const line of breakdown.lines) {
      if (!members.includes(line.product)) continue;
      units += line.units ?? 0;
      if (line.usd !== null) total = (total ?? 0) + line.usd;
    }
    const discount = 1 - (ctx.pricing.table.discountPercent ?? 0) / 100;
    return { usd: total === null ? null : total * discount, units };
  };
  const limits = ctx.snap.billing?.limitsUsd ?? {};
  const out: BillingLimitSuggestion[] = [];
  for (const g of groups) {
    const now = sum(base, g.members);
    if (now.units <= 0 && limits[g.product] === undefined) continue;
    const nr = sum(afterNoRegret, g.members).usd;
    const all = sum(afterAll, g.members).usd;
    const existing = ctx.snap.billing ? (limits[g.product] ?? null) : undefined;
    let suggested: number | null = null;
    let rationale: string;
    if (now.usd === null || nr === null) {
      rationale = 'No verified price, so no dollar limit is suggested.';
    } else if (now.usd === 0 && nr === 0) {
      suggested = 0;
      rationale = 'Inside the free tier. A $0 limit keeps it free; data beyond the free allowance is then dropped for the rest of the month.';
    } else {
      suggested = niceLimit(nr * LIMIT_HEADROOM);
      const preFix = niceLimit(now.usd * LIMIT_HEADROOM);
      rationale =
        nr < now.usd * 0.98
          ? `Expected ≈${usd(nr)}/mo after the no-regret fixes (≈${usd(now.usd)} now). ${usd(suggested)} leaves ~30% headroom and caps a runaway spike. Apply the fixes first, or start at ${usd(preFix)} and lower it later.`
          : `Expected ≈${usd(now.usd)}/mo. ${usd(suggested)} leaves ~30% headroom and caps a runaway spike.`;
    }
    out.push({
      product: g.product,
      label: g.label,
      currentUsd: now.usd,
      afterNoRegretUsd: nr,
      afterAllUsd: all,
      existingLimitUsd: existing,
      suggestedLimitUsd: suggested,
      rationale,
    });
  }
  return out;
}

function urlClasses(ctx: AnalysisContext): AuditResult['urlClasses'] {
  const weights = new Map<string, Map<UrlClass, number>>();
  for (const p of ctx.snap.events?.byPage ?? []) {
    const host = p.host.toLowerCase();
    if (!host) continue;
    const classes = weights.get(host) ?? new Map<UrlClass, number>();
    const c = ctx.classify(host, p.path);
    classes.set(c, (classes.get(c) ?? 0) + p.count);
    weights.set(host, classes);
  }
  const hosts = ctx.snap.events?.byHost ?? [];
  const rows = (hosts.length > 0 ? hosts : [...weights.entries()].map(([host, m]) => ({ host, count: [...m.values()].reduce((s, n) => s + n, 0) })))
    .filter((h) => h.host)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  return rows.map((h) => {
    const classes = weights.get(h.host.toLowerCase());
    let urlClass: UrlClass = ctx.classify(h.host, '/');
    if (classes && classes.size > 0) {
      urlClass = [...classes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? urlClass;
    }
    return { host: h.host, urlClass, reason: ctx.classifier.devReason(h.host), events: ctx.monthlyEvents(h.count) };
  });
}

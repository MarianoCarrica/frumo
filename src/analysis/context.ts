import { DAYS_PER_MONTH, EXCEPTION_EVENT, SURVEY_RESPONSE_EVENT } from '../posthog-facts.js';
import { applyPricingOverride, publicPricing } from '../pricing/override.js';
import type { EffectivePricing, PricingOverride } from '../pricing/override.js';
import type { ProductKey } from '../pricing/types.js';
import { PRODUCT_FOR_USAGE, USAGE_KEYS, emptyUsage } from '../snapshot.js';
import type { Snapshot, Usage, UsageKey } from '../snapshot.js';
import { costBreakdown, productCost } from './costs.js';
import type { CostBreakdown, Driver, Finding, Fix } from './model.js';
import { UrlClassifier } from './url-class.js';
import type { UrlClass } from './url-class.js';

export interface AnalysisOptions {
  toolVersion: string;
  /** Extra regexes (full URL) that mark marketing/content pages. */
  marketingPatterns?: RegExp[];
  /** Regexes (full URL) that mark app pages; win over marketing. */
  appPatterns?: RegExp[];
  /** Regexes (host) that mark local/preview/staging hosts. */
  devHostPatterns?: RegExp[];
  /** Always-on server instances assumed when estimating local-evaluation polling. Default 4. */
  serverInstances?: number;
  /** --pricing file contents (wins over everything else). */
  pricingOverride?: PricingOverride | null;
  /** Use tiers from the organization's billing plan when the snapshot has them. Default true. */
  usePlanPricing?: boolean;
  /** Clock override for reproducible output. */
  now?: Date;
}

export interface AnalyzerOutput {
  drivers: Driver[];
  fixes: Fix[];
  findings: Finding[];
  notAnalyzed: string[];
}

export function emptyOutput(): AnalyzerOutput {
  return { drivers: [], fixes: [], findings: [], notAnalyzed: [] };
}

const STAGING_PROJECT_NAME = /(staging|stage|stg|\bdev\b|development|\btest\b|testing|\bqa\b|\buat\b|sandbox|preview|local|\bci\b)/i;

export function looksLikeStagingProject(name: string | null): boolean {
  return name !== null && STAGING_PROJECT_NAME.test(name);
}

export class AnalysisContext {
  readonly snap: Snapshot;
  readonly options: AnalysisOptions;
  readonly pricing: EffectivePricing;
  /** Multiply window counts by this to get a 30-day month. */
  readonly monthlyFactor: number;
  /** Monthly usage for the whole organization (what the bill is computed on). */
  readonly org: Usage;
  /** Monthly usage for the audited project. */
  readonly project: Usage;
  readonly scope: 'organization' | 'project';
  readonly classifier: UrlClassifier;
  readonly baseCost: CostBreakdown;
  readonly serverInstances: number;
  readonly notes: string[] = [];
  private readonly scale: Record<'events' | 'identifiedEvents' | 'recordings', number>;

  constructor(snap: Snapshot, options: AnalysisOptions) {
    this.snap = snap;
    this.options = options;
    this.monthlyFactor = DAYS_PER_MONTH / snap.period.days;
    this.serverInstances = Math.max(1, Math.round(options.serverInstances ?? 4));
    this.pricing = this.resolvePricing();

    const derived = deriveProjectUsage(snap);
    const { project, org, scope } = this.resolveUsage(derived);
    this.scope = scope;
    this.project = scaleUsage(project, this.monthlyFactor);
    this.org = scaleUsage(org, this.monthlyFactor);
    this.scale = {
      events: ratio(project.events, derived.events),
      identifiedEvents: ratio(project.identifiedEvents, derived.identifiedEvents),
      recordings: ratio(project.recordings, derived.recordings),
    };

    const knownHosts = [
      ...(snap.events?.byHost ?? []).map((h) => h.host),
      ...(snap.events?.byPage ?? []).map((p) => p.host),
    ];
    this.classifier = new UrlClassifier(
      { marketing: options.marketingPatterns ?? [], app: options.appPatterns ?? [], dev: options.devHostPatterns ?? [] },
      knownHosts,
    );
    this.baseCost = costBreakdown(this.org, this.pricing);
  }

  private resolvePricing(): EffectivePricing {
    let pricing = publicPricing();
    const plan = this.snap.billing?.pricing;
    if (plan && this.options.usePlanPricing !== false && Object.keys(plan.products).length > 0) {
      pricing = applyPricingOverride(pricing, plan, 'billing-api');
      this.notes.push('Prices for some products come from your organization\'s billing plan (GET /api/billing/).');
    }
    const discount = this.snap.billing?.discountPercent;
    if (discount !== null && discount !== undefined && discount > 0) {
      pricing = applyPricingOverride(pricing, { products: {}, discountPercent: discount }, 'billing-api');
    }
    if (this.options.pricingOverride) {
      pricing = applyPricingOverride(pricing, this.options.pricingOverride, 'override');
    }
    return pricing;
  }

  private resolveUsage(derived: Usage): { project: Usage; org: Usage; scope: 'organization' | 'project' } {
    const rows = this.snap.orgUsage ?? [];
    if (rows.length === 0) return { project: derived, org: { ...derived }, scope: 'project' };

    let audited = rows.find((r) => r.audited);
    if (!audited && this.snap.project.id !== null) audited = rows.find((r) => r.projectId === this.snap.project.id);
    const project = emptyUsage();
    for (const key of USAGE_KEYS) project[key] = audited?.usage[key] ?? derived[key];

    const org = emptyUsage();
    for (const key of USAGE_KEYS) {
      let total: number | null = null;
      for (const row of rows) {
        const value = row === audited ? project[key] : row.usage[key];
        if (value !== null) total = (total ?? 0) + value;
      }
      if (!audited && project[key] !== null) total = (total ?? 0) + (project[key] ?? 0);
      org[key] = total;
    }
    if (!audited) {
      this.notes.push('The billing usage did not identify the audited project; its own counts were added to the organization totals.');
    }
    return { project, org, scope: 'organization' };
  }

  /** Window count of project billable events → monthly units (scaled to billing totals when known). */
  monthlyEvents(windowCount: number): number {
    return windowCount * this.monthlyFactor * this.scale.events;
  }

  monthlyIdentified(windowCount: number): number {
    return windowCount * this.monthlyFactor * this.scale.identifiedEvents;
  }

  monthlyRecordings(windowCount: number): number {
    return windowCount * this.monthlyFactor * this.scale.recordings;
  }

  /** Plain window → month conversion (for meters without a billing-side total). */
  monthly(windowCount: number): number {
    return windowCount * this.monthlyFactor;
  }

  /** Project-wide share of billable events that are identified (0 when unknown). */
  identifiedShare(): number {
    const t = this.snap.events?.totals;
    if (!t || t.billableIdentified === null || t.billable <= 0) return 0;
    return Math.min(1, t.billableIdentified / t.billable);
  }

  /** Average effective price per unit on a meter at the organization's volume (null if unknown). */
  averageRate(key: UsageKey): number | null {
    const units = this.org[key];
    if (units === null || units <= 0) return null;
    const cost = productCost(PRODUCT_FOR_USAGE[key], units, this.pricing);
    if (cost === null) return null;
    return (cost / units) * (1 - (this.pricing.table.discountPercent ?? 0) / 100);
  }

  /**
   * Share of the bill attributable to a slice of events at the average effective rates:
   * anonymous events pay the event rate; identified events also pay the person-profile rate.
   */
  allocateEvents(monthlyCount: number, monthlyIdentified: number): number | null {
    const base = this.averageRate('events');
    if (base === null) return null;
    const addon = this.averageRate('identifiedEvents') ?? 0;
    const identified = Math.min(monthlyCount, Math.max(0, monthlyIdentified));
    return monthlyCount * base + identified * addon;
  }

  allocate(key: UsageKey, monthlyUnits: number): number | null {
    const rate = this.averageRate(key);
    return rate === null ? null : monthlyUnits * rate;
  }

  priceKnown(product: ProductKey): boolean {
    return this.pricing.table.products[product].tiers !== null;
  }

  classify(host: string | null | undefined, path: string | null | undefined): UrlClass {
    return this.classifier.classify(host, path);
  }

  /** App host to link to (us/eu cloud or self-hosted), for settings deep links. */
  appHost(): string {
    const host = this.snap.source.host;
    if (host && /^https?:\/\//.test(host)) return host.replace(/\/+$/, '');
    return 'https://us.posthog.com';
  }

  hasRealAppHost(): boolean {
    return this.snap.source.host !== null;
  }

  windowLabel(): string {
    return `${this.snap.period.days} day${this.snap.period.days === 1 ? '' : 's'}`;
  }
}

function ratio(numerator: number | null, denominator: number | null): number {
  if (numerator === null || denominator === null || denominator <= 0 || numerator <= 0) return 1;
  return numerator / denominator;
}

function scaleUsage(usage: Usage, factor: number): Usage {
  const out = emptyUsage();
  for (const key of USAGE_KEYS) {
    const v = usage[key];
    out[key] = v === null ? null : v * factor;
  }
  return out;
}

/** Project usage in the snapshot window, from the HogQL-derived sections. */
export function deriveProjectUsage(snap: Snapshot): Usage {
  const usage = emptyUsage();
  const events = snap.events;
  if (events) {
    usage.events = events.totals.billable;
    usage.identifiedEvents = events.totals.billableIdentified;
    const find = (name: string): number | null => events.byEvent.find((e) => e.event === name)?.count ?? null;
    usage.surveyResponses = find(SURVEY_RESPONSE_EVENT);
    usage.exceptions = find(EXCEPTION_EVENT);
  }
  if (snap.replay) usage.recordings = snap.replay.recordings;
  return usage;
}

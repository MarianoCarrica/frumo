import type { PriceSource, PricingTable, ProductKey } from '../pricing/types.js';
import type { SourceKind, Usage, UsageKey } from '../snapshot.js';
import type { UrlClass } from './url-class.js';

/** A change in monthly organization usage caused by a fix. */
export interface Effect {
  key: UsageKey;
  /** Fraction (0..1) of the organization's monthly usage on this meter that the fix removes. */
  removeFraction: number;
  /** Units the fix adds back (e.g. local-evaluation polling requests). */
  addUnits?: number;
}

export interface EvidenceTable {
  title: string;
  columns: string[];
  rows: Array<Array<string | number>>;
  note?: string;
}

export interface Driver {
  id: string;
  title: string;
  /** Main price list the volume is charged on. */
  product: ProductKey;
  /** Monthly units attributed to the driver (normalized to 30 days). */
  units: number;
  unitLabel: string;
  /** Share of this month's bill attributed to the driver at your average effective rate. null = price unknown. */
  costUsd: number | null;
  /** Share of the product's monthly units (0..1), when meaningful. */
  shareOfProduct: number | null;
  detail: string;
  evidence: EvidenceTable[];
  fixIds: string[];
}

export type FixKind = 'no-regret' | 'trade-off';

export interface Snippet {
  title: string;
  language: 'js' | 'ts' | 'python' | 'diff' | 'text';
  code: string;
}

/** A posthog.init option a fix wants to set (merged into one combined diff). */
export interface InitOption {
  /** Top-level option name, or `autocapture.<option>` for autocapture sub-options. */
  key: string;
  /** JavaScript source for the value. */
  value: string;
  comment: string;
  /** Statements the value depends on (e.g. `const isMarketingPage = ...`). */
  preamble?: string[];
}

export interface Fix {
  id: string;
  title: string;
  kind: FixKind;
  products: ProductKey[];
  effects: Effect[];
  /** The volume assumption behind the dollar estimate, in plain words. */
  assumption: string;
  /** What data or behaviour you give up. */
  youLose: string;
  /** Non-code steps (e.g. project settings). */
  steps: string[];
  snippets: Snippet[];
  initOptions: InitOption[];
  docs: Array<{ title: string; url: string }>;
  /** Short evidence line shown next to the fix. */
  evidence: string;
}

export interface FixResult extends Fix {
  /** Monthly saving if only this fix is applied. null = price unknown for every affected product. */
  savingUsd: number | null;
  /** True when some affected product has no verified price (saving excludes it). */
  savingPartial: boolean;
  /** Monthly units removed per meter (negative = added). */
  unitsRemoved: Partial<Record<UsageKey, number>>;
}

export interface CostLine {
  product: ProductKey;
  usageKey: UsageKey;
  label: string;
  units: number | null;
  unitPlural: string;
  usd: number | null;
  freeAllowance: number;
  /** Why usd is null. */
  missing?: 'usage-unknown' | 'price-unverified';
  priceSource: PriceSource;
}

export interface CostBreakdown {
  lines: CostLine[];
  /** Sum of known lines before discount. */
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
}

export interface BillingLimitSuggestion {
  product: ProductKey;
  label: string;
  currentUsd: number | null;
  afterNoRegretUsd: number | null;
  afterAllUsd: number | null;
  existingLimitUsd: number | null | undefined;
  suggestedLimitUsd: number | null;
  rationale: string;
}

export interface Finding {
  level: 'info' | 'warning';
  text: string;
}

export interface AuditResult {
  schema: 'eventspend.report/v1';
  tool: { name: 'eventspend'; version: string };
  generatedAt: string;
  input: {
    sourceKind: SourceKind;
    label: string | null;
    fictional: boolean;
    host: string | null;
    projectId: string | null;
    projectName: string | null;
    periodDays: number;
    periodStart: string | null;
    periodEnd: string | null;
    /** "organization": costs use org-wide usage from the billing API; "project": only this project's data was available. */
    scope: 'organization' | 'project';
    projects: Array<{ id: string; name: string | null; audited: boolean; staging: boolean }>;
  };
  pricing: {
    table: PricingTable;
    sources: Record<ProductKey, PriceSource>;
    unverified: ProductKey[];
  };
  usage: { org: Usage; project: Usage };
  costs: CostBreakdown;
  billingApi: { projectedTotalUsd: number | null; currentTotalUsd: number | null } | null;
  savings: {
    allUsd: number;
    noRegretUsd: number;
    allPct: number;
    noRegretPct: number;
    costAfterAllUsd: number;
    costAfterNoRegretUsd: number;
  };
  drivers: Driver[];
  fixes: FixResult[];
  initDiff: string | null;
  billingLimits: BillingLimitSuggestion[];
  urlClasses: Array<{ host: string; urlClass: UrlClass; reason: string | null; events: number }>;
  findings: Finding[];
  notAnalyzed: string[];
  notes: string[];
  disclaimer: string;
}

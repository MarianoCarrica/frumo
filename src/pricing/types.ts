/**
 * Pricing model types. Prices themselves live in exactly one place:
 * `src/pricing/public-pricing.ts` (enforced by test/repo-rules.test.ts).
 */

/** Products frumo can put a dollar figure on. */
export const PRODUCT_KEYS = [
  'product_analytics',
  'identified_events',
  'session_replay',
  'mobile_replay',
  'feature_flags',
  'surveys',
  'error_tracking',
] as const;

export type ProductKey = (typeof PRODUCT_KEYS)[number];

export function isProductKey(value: unknown): value is ProductKey {
  return typeof value === 'string' && (PRODUCT_KEYS as readonly string[]).includes(value);
}

/**
 * One step of graduated (tiered) pricing, PostHog/Stripe style.
 * `upTo` is the cumulative upper bound of the tier (null = unbounded, only allowed on the last tier).
 * Every unit between the previous tier's `upTo` and this `upTo` costs `unitUsd`.
 */
export interface PriceTier {
  readonly upTo: number | null;
  readonly unitUsd: number;
  /** Optional one-off fee charged when usage enters this tier. PostHog's public tiers have none. */
  readonly flatUsd?: number;
}

export interface ProductPricing {
  /** Human label, e.g. "Product analytics events". */
  readonly label: string;
  /** Singular unit, e.g. "event". */
  readonly unit: string;
  readonly unitPlural: string;
  /** Free units per month (also encoded as a $0 first tier). */
  readonly freeAllowance: number;
  /**
   * Graduated tiers, or null when the price could not be verified.
   * A null price means "no dollar estimate": frumo reports volumes only and says so.
   */
  readonly tiers: readonly PriceTier[] | null;
  /** Plan identifier the numbers were read from, when known. */
  readonly planKey?: string;
  /** Where the numbers were checked. */
  readonly verifiedFrom?: readonly string[];
  /** Why the price is null (required when tiers is null). */
  readonly unverifiedReason?: string;
}

export interface PricingTable {
  /** Display name, e.g. "PostHog public pricing". */
  readonly name: string;
  /** Source URL or description. */
  readonly source: string;
  /** ISO date (YYYY-MM-DD) the prices were retrieved or agreed. */
  readonly retrieved: string;
  readonly currency: 'USD';
  /** Optional percentage discount applied to the whole bill (e.g. a contract discount). */
  readonly discountPercent?: number;
  readonly notes: readonly string[];
  readonly products: Readonly<Record<ProductKey, ProductPricing>>;
}

/** Where a product's effective price came from. */
export type PriceSource = 'public' | 'billing-api' | 'override';

/** Sentry plans frumo can estimate (public pay-as-you-go list prices). */
export const SENTRY_PLANS = ['team', 'business'] as const;
export type SentryPlan = (typeof SENTRY_PLANS)[number];

/** Sentry billing categories frumo estimates. Attachments are billed per GB. */
export const SENTRY_BILLED_CATEGORIES = ['errors', 'spans', 'replays', 'attachments'] as const;
export type SentryBilledCategory = (typeof SENTRY_BILLED_CATEGORIES)[number];

export interface SentryCategoryPricing {
  readonly label: string;
  readonly unit: string;
  readonly unitPlural: string;
  /** Monthly volume included with the paid plan (also encoded as a $0 first tier). */
  readonly included: number;
  /** Graduated PAYG tiers per plan, in `unit`s. */
  readonly tiers: Readonly<Record<SentryPlan, readonly PriceTier[]>>;
}

export interface SentryPricingTable {
  readonly name: string;
  readonly sources: readonly string[];
  /** ISO date the prices were checked. */
  readonly retrieved: string;
  readonly currency: 'USD';
  readonly notes: readonly string[];
  readonly categories: Readonly<Record<SentryBilledCategory, SentryCategoryPricing>>;
}

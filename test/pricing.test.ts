import { describe, expect, it } from 'vitest';
import { averageUnitCost, freeUnitsFromTiers, marginalUnitCost, tierProblems, tieredCost } from '../src/pricing/math.js';
import { applyPricingOverride, parsePricingOverride, publicPricing } from '../src/pricing/override.js';
import { PUBLIC_PRICING } from '../src/pricing/public-pricing.js';
import { PRODUCT_KEYS } from '../src/pricing/types.js';
import type { PriceTier } from '../src/pricing/types.js';
import { ValidationError } from '../src/util/validate.js';

const P = PUBLIC_PRICING.products;
const tiers = (key: keyof typeof P): readonly PriceTier[] => {
  const t = P[key].tiers;
  if (!t) throw new Error(`no tiers for ${key}`);
  return t;
};

describe('tieredCost (graduated tiers, free allowance applied)', () => {
  it('is free inside the free allowance and for zero/invalid usage', () => {
    expect(tieredCost(0, tiers('product_analytics'))).toBe(0);
    expect(tieredCost(-5, tiers('product_analytics'))).toBe(0);
    expect(tieredCost(Number.NaN, tiers('product_analytics'))).toBe(0);
    expect(tieredCost(1_000_000, tiers('product_analytics'))).toBe(0);
    expect(tieredCost(5_000, tiers('session_replay'))).toBe(0);
    expect(tieredCost(1_500, tiers('surveys'))).toBe(0);
  });

  it('charges each unit at the rate of the tier it falls in', () => {
    // 1 unit past the free tier costs the second tier's price.
    expect(tieredCost(1_000_001, tiers('product_analytics'))).toBeCloseTo(0.00005, 10);
    // Exactly at a boundary: 2M events = 1M free + 1M × $0.00005.
    expect(tieredCost(2_000_000, tiers('product_analytics'))).toBeCloseTo(50, 6);
  });

  it("matches PostHog's own worked example: 10M anonymous events ≈ $324/month", () => {
    // posthog.com/blog/analytics-pricing: "a website owner who sends 10m events per month would pay just $324"
    expect(tieredCost(10_000_000, tiers('product_analytics'))).toBeCloseTo(324.4, 6);
  });

  it('prices identified events as base rate plus the person-profile add-on (blog: saving $9,072/year at 10M)', () => {
    const base = tieredCost(10_000_000, tiers('product_analytics'));
    const addon = tieredCost(10_000_000, tiers('identified_events'));
    expect(addon).toBeCloseTo(755.6, 6);
    expect(base + addon).toBeCloseTo(1080, 6);
    expect(Math.round(addon) * 12).toBe(9072);
  });

  it('reaches the last, unbounded tier', () => {
    // 300M events: 50 + 13M×0.0000343 + 35M×0.0000295 + 50M×0.0000218 + 150M×0.000015 + 50M×0.000009
    expect(tieredCost(300_000_000, tiers('product_analytics'))).toBeCloseTo(5318.4, 4);
    // 1M web recordings: 50 + 122.5 + 200 + 595 + 750
    expect(tieredCost(1_000_000, tiers('session_replay'))).toBeCloseTo(1717.5, 6);
  });

  it('computes the demo-sized products', () => {
    expect(tieredCost(11_320_000, tiers('feature_flags'))).toBeCloseTo(493, 6);
    expect(tieredCost(72_600, tiers('session_replay'))).toBeCloseTo(217.7, 6);
    expect(tieredCost(2_500, tiers('surveys'))).toBeCloseTo(67.5, 6);
    expect(tieredCost(400_000, tiers('error_tracking'))).toBeCloseTo(93.75, 6);
    expect(tieredCost(20_000, tiers('mobile_replay'))).toBeCloseTo(125 + 35, 6);
  });

  it('applies flat tier fees once when usage enters the tier', () => {
    const withFlat: PriceTier[] = [
      { upTo: 10, unitUsd: 0 },
      { upTo: 20, unitUsd: 1, flatUsd: 5 },
      { upTo: null, unitUsd: 0.5, flatUsd: 100 },
    ];
    expect(tieredCost(10, withFlat)).toBe(0);
    expect(tieredCost(11, withFlat)).toBe(6);
    expect(tieredCost(20, withFlat)).toBe(15);
    expect(tieredCost(22, withFlat)).toBe(15 + 1 + 100);
  });

  it('reports average and marginal unit prices', () => {
    expect(marginalUnitCost(500_000, tiers('product_analytics'))).toBe(0);
    expect(marginalUnitCost(1_500_000, tiers('product_analytics'))).toBe(0.00005);
    expect(marginalUnitCost(1_000_000_000, tiers('product_analytics'))).toBe(0.000009);
    expect(averageUnitCost(10_000_000, tiers('product_analytics'))).toBeCloseTo(0.00003244, 10);
    expect(averageUnitCost(0, tiers('product_analytics'))).toBe(0);
  });
});

describe('tier validation', () => {
  it('accepts the public tiers', () => {
    for (const key of PRODUCT_KEYS) expect(tierProblems(tiers(key)), key).toEqual([]);
  });

  it('rejects unordered, bounded-last, negative and empty tier lists', () => {
    expect(tierProblems([])).toHaveLength(1);
    expect(tierProblems([{ upTo: 10, unitUsd: 0 }]).join()).toMatch(/last tier must be unbounded/);
    expect(tierProblems([{ upTo: null, unitUsd: 0 }, { upTo: null, unitUsd: 1 }]).join()).toMatch(/only the last tier/);
    expect(tierProblems([{ upTo: 10, unitUsd: 0 }, { upTo: 5, unitUsd: 1 }, { upTo: null, unitUsd: 1 }]).join()).toMatch(/greater than/);
    expect(tierProblems([{ upTo: null, unitUsd: -1 }]).join()).toMatch(/unitUsd/);
  });

  it('derives the free allowance from leading $0 tiers', () => {
    expect(freeUnitsFromTiers(tiers('feature_flags'))).toBe(1_000_000);
    expect(freeUnitsFromTiers([{ upTo: null, unitUsd: 0.1 }])).toBe(0);
  });
});

describe('public pricing data file', () => {
  it('names its source and retrieval date', () => {
    expect(PUBLIC_PRICING.source).toBe('https://posthog.com/pricing');
    expect(PUBLIC_PRICING.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PUBLIC_PRICING.currency).toBe('USD');
  });

  it('has a verified price list for every product, with a free tier that matches freeAllowance', () => {
    for (const key of PRODUCT_KEYS) {
      const p = P[key];
      expect(p.tiers, key).not.toBeNull();
      expect(p.verifiedFrom?.length, key).toBeGreaterThan(0);
      expect(freeUnitsFromTiers(tiers(key)), key).toBe(p.freeAllowance);
    }
  });

  it('matches the free allowances listed on posthog.com/pricing', () => {
    expect(P.product_analytics.freeAllowance).toBe(1_000_000);
    expect(P.session_replay.freeAllowance).toBe(5_000);
    expect(P.feature_flags.freeAllowance).toBe(1_000_000);
    expect(P.surveys.freeAllowance).toBe(1_500);
    expect(P.error_tracking.freeAllowance).toBe(100_000);
  });

  it('identified = base + add-on reproduces the per-tier identified prices PostHog published', () => {
    // Identified-event column from posthog.com/blog/analytics-pricing (per event).
    const published = [0, 0.000248, 0.000104, 0.0000655, 0.0000364, 0.0000187, 0.00001];
    const base = tiers('product_analytics');
    const addon = tiers('identified_events');
    published.forEach((price, i) => {
      expect((base[i]?.unitUsd ?? NaN) + (addon[i]?.unitUsd ?? NaN)).toBeCloseTo(price, 10);
      expect(base[i]?.upTo).toBe(addon[i]?.upTo);
    });
  });
});

describe('pricing overrides (--pricing and billing-plan tiers)', () => {
  it('replaces only the products it lists and records the source', () => {
    const override = parsePricingOverride({
      name: 'Contract 2026',
      source: 'Order form',
      retrieved: '2026-11-01',
      discountPercent: 10,
      products: { product_analytics: { tiers: [{ upTo: 1_000_000, unitUsd: 0 }, { upTo: null, unitUsd: 0.00002 }] } },
    });
    const effective = applyPricingOverride(publicPricing(), override, 'override');
    expect(effective.sources.product_analytics).toBe('override');
    expect(effective.sources.session_replay).toBe('public');
    expect(effective.table.discountPercent).toBe(10);
    expect(effective.table.name).toBe('Contract 2026');
    const t = effective.table.products.product_analytics.tiers;
    expect(t && tieredCost(3_000_000, t)).toBeCloseTo(40, 6);
    expect(effective.table.products.product_analytics.freeAllowance).toBe(1_000_000);
  });

  it("accepts PostHog's billing API tier shape (strings, snake_case)", () => {
    const override = parsePricingOverride({
      products: {
        feature_flags: {
          tiers: [
            { up_to: 1000000, unit_amount_usd: '0', flat_amount_usd: '0' },
            { up_to: null, unit_amount_usd: '0.00002', flat_amount_usd: '0' },
          ],
        },
      },
    });
    expect(override.products.feature_flags?.tiers).toEqual([
      { upTo: 1000000, unitUsd: 0 },
      { upTo: null, unitUsd: 0.00002 },
    ]);
  });

  it('marks a product unverified with tiers: null', () => {
    const override = parsePricingOverride({ products: { session_replay: { tiers: null, unverifiedReason: 'not on contract' } } });
    const effective = applyPricingOverride(publicPricing(), override, 'override');
    expect(effective.table.products.session_replay.tiers).toBeNull();
    expect(effective.table.products.session_replay.unverifiedReason).toBe('not on contract');
  });

  it('lists every problem in an invalid file', () => {
    try {
      parsePricingOverride({ discountPercent: 140, products: { warp_drive: { tiers: [] }, surveys: { tiers: [{ upTo: 5, unitUsd: -1 }] }, feature_flags: {} } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues.join('\n');
      expect(issues).toMatch(/discountPercent/);
      expect(issues).toMatch(/products\.warp_drive: unknown product/);
      expect(issues).toMatch(/products\.surveys\.tiers\[0\]\.unitUsd/);
      expect(issues).toMatch(/products\.feature_flags\.tiers: required/);
    }
  });
});

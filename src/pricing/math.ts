import type { PriceTier } from './types.js';

/**
 * Graduated (tiered) cost of `units`.
 *
 * Each tier covers (previous upTo, upTo]; units in a tier are charged that tier's unit price.
 * A tier's optional flat fee is charged once if any unit falls into it. The free allowance is
 * simply the first tier with a unit price of 0.
 *
 * Example (PostHog events): 9.3M events → 1M free + 1M × $0.00005 + 7.3M × $0.0000343 = $300.39
 */
export function tieredCost(units: number, tiers: readonly PriceTier[]): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  let cost = 0;
  let lower = 0;
  for (const tier of tiers) {
    const upper = tier.upTo ?? Number.POSITIVE_INFINITY;
    if (units > lower) {
      const inTier = Math.min(units, upper) - lower;
      cost += inTier * tier.unitUsd + (tier.flatUsd ?? 0);
    }
    if (units <= upper) break;
    lower = upper;
  }
  return cost;
}

/** Average price per unit at this volume (0 when units is 0). */
export function averageUnitCost(units: number, tiers: readonly PriceTier[]): number {
  return units > 0 ? tieredCost(units, tiers) / units : 0;
}

/** Price of the next unit at this volume (the tier the usage currently ends in). */
export function marginalUnitCost(units: number, tiers: readonly PriceTier[]): number {
  for (const tier of tiers) {
    if (tier.upTo === null || units < tier.upTo) return tier.unitUsd;
  }
  return tiers[tiers.length - 1]?.unitUsd ?? 0;
}

/** Returns human-readable problems with a tier list (empty when valid). */
export function tierProblems(tiers: readonly PriceTier[], path = 'tiers'): string[] {
  const problems: string[] = [];
  if (tiers.length === 0) {
    problems.push(`${path}: at least one tier is required`);
    return problems;
  }
  let previous = 0;
  tiers.forEach((tier, index) => {
    const at = `${path}[${index}]`;
    const isLast = index === tiers.length - 1;
    if (!Number.isFinite(tier.unitUsd) || tier.unitUsd < 0) {
      problems.push(`${at}.unitUsd: must be a number >= 0`);
    }
    if (tier.flatUsd !== undefined && (!Number.isFinite(tier.flatUsd) || tier.flatUsd < 0)) {
      problems.push(`${at}.flatUsd: must be a number >= 0`);
    }
    if (tier.upTo === null) {
      if (!isLast) problems.push(`${at}.upTo: only the last tier may be unbounded (null)`);
    } else {
      if (!Number.isFinite(tier.upTo) || tier.upTo <= previous) {
        problems.push(`${at}.upTo: must be greater than the previous tier's upTo (${previous})`);
      } else {
        previous = tier.upTo;
      }
      if (isLast) problems.push(`${at}.upTo: the last tier must be unbounded (upTo: null)`);
    }
  });
  return problems;
}

/** Free units implied by the tiers (units covered by leading $0 tiers without flat fees). */
export function freeUnitsFromTiers(tiers: readonly PriceTier[]): number {
  let free = 0;
  for (const tier of tiers) {
    if (tier.unitUsd !== 0 || (tier.flatUsd ?? 0) !== 0) break;
    if (tier.upTo === null) return Number.POSITIVE_INFINITY;
    free = tier.upTo;
  }
  return free;
}

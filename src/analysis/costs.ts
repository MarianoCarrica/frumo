import { tieredCost } from '../pricing/math.js';
import type { EffectivePricing } from '../pricing/override.js';
import type { ProductKey } from '../pricing/types.js';
import { PRODUCT_FOR_USAGE, USAGE_KEYS } from '../snapshot.js';
import type { Usage, UsageKey } from '../snapshot.js';
import type { CostBreakdown, CostLine, Effect } from './model.js';

/** Monthly cost of an organization's usage, product by product (graduated tiers, free tier applied). */
export function costBreakdown(usage: Usage, pricing: EffectivePricing): CostBreakdown {
  const lines: CostLine[] = USAGE_KEYS.map((key) => {
    const product = PRODUCT_FOR_USAGE[key];
    const p = pricing.table.products[product];
    const units = usage[key];
    const line: CostLine = {
      product,
      usageKey: key,
      label: p.label,
      units,
      unitPlural: p.unitPlural,
      usd: null,
      freeAllowance: p.freeAllowance,
      priceSource: pricing.sources[product],
    };
    if (units === null) line.missing = 'usage-unknown';
    else if (p.tiers === null) line.missing = 'price-unverified';
    else line.usd = tieredCost(units, p.tiers);
    return line;
  });
  const subtotalUsd = lines.reduce((sum, l) => sum + (l.usd ?? 0), 0);
  const discountUsd = subtotalUsd * ((pricing.table.discountPercent ?? 0) / 100);
  return { lines, subtotalUsd, discountUsd, totalUsd: subtotalUsd - discountUsd };
}

/** Cost of one product's units (null when its price is unverified). */
export function productCost(product: ProductKey, units: number, pricing: EffectivePricing): number | null {
  const tiers = pricing.table.products[product].tiers;
  return tiers === null ? null : tieredCost(units, tiers);
}

/**
 * Applies fix effects to monthly usage. Fractions apply to the *current* value, so applying
 * several fixes in sequence assumes their targets overlap independently (conservative: the
 * combined saving is never more than the sum of the individual ones).
 * Identified events can never exceed events.
 */
export function applyEffects(usage: Usage, effects: readonly Effect[]): Usage {
  const next: Usage = { ...usage };
  for (const effect of effects) {
    const current = next[effect.key];
    if (current === null) continue;
    const fraction = Math.min(1, Math.max(0, effect.removeFraction));
    next[effect.key] = Math.max(0, current * (1 - fraction) + (effect.addUnits ?? 0));
  }
  if (next.events !== null && next.identifiedEvents !== null && next.identifiedEvents > next.events) {
    next.identifiedEvents = next.events;
  }
  return next;
}

export interface SavingResult {
  savingUsd: number | null;
  partial: boolean;
  unitsRemoved: Partial<Record<UsageKey, number>>;
}

/** Monthly saving from moving `before` → `after` usage (discount applied). */
export function savingBetween(before: Usage, after: Usage, pricing: EffectivePricing): SavingResult {
  let saving = 0;
  let known = false;
  let partial = false;
  const unitsRemoved: Partial<Record<UsageKey, number>> = {};
  for (const key of USAGE_KEYS) {
    const b = before[key];
    const a = after[key];
    if (b === null || a === null || b === a) continue;
    unitsRemoved[key] = b - a;
    const product = PRODUCT_FOR_USAGE[key];
    const costBefore = productCost(product, b, pricing);
    const costAfter = productCost(product, a, pricing);
    if (costBefore === null || costAfter === null) {
      partial = true;
      continue;
    }
    known = true;
    saving += costBefore - costAfter;
  }
  const discount = (pricing.table.discountPercent ?? 0) / 100;
  return { savingUsd: known ? saving * (1 - discount) : null, partial, unitsRemoved };
}

/** Removes the share `units / total` of a meter, guarding against unknown or zero totals. */
export function fractionOf(units: number, total: number | null): number {
  if (total === null || total <= 0 || units <= 0) return 0;
  return Math.min(1, units / total);
}

import { freeUnitsFromTiers, tierProblems } from './math.js';
import { PUBLIC_PRICING } from './public-pricing.js';
import { PRODUCT_KEYS, isProductKey } from './types.js';
import type { PriceSource, PriceTier, PricingTable, ProductKey, ProductPricing } from './types.js';
import { Issues, isRecord } from '../util/validate.js';

/**
 * A partial pricing table: what `--pricing <file>` contains, and what live mode derives from the
 * organization's own billing plan (GET /api/billing/). Products you don't list keep public prices.
 *
 * {
 *   "name": "Our 2026 contract",
 *   "source": "Order form #123",
 *   "retrieved": "2026-11-01",
 *   "discountPercent": 15,
 *   "products": {
 *     "product_analytics": { "tiers": [ { "upTo": 1000000, "unitUsd": 0 }, { "upTo": null, "unitUsd": 0.00002 } ] },
 *     "session_replay":    { "tiers": null, "unverifiedReason": "Not on our contract" }
 *   }
 * }
 */
export interface PricingOverride {
  name?: string;
  source?: string;
  retrieved?: string;
  discountPercent?: number;
  notes?: string[];
  products: Partial<Record<ProductKey, ProductOverride>>;
}

export interface ProductOverride {
  tiers: PriceTier[] | null;
  freeAllowance?: number;
  label?: string;
  unverifiedReason?: string;
}

/** Validates untrusted JSON into a PricingOverride. Throws ValidationError listing every problem. */
export function parsePricingOverride(json: unknown, what = 'Pricing file'): PricingOverride {
  const issues = new Issues();
  const root = issues.record(json, '');
  const result: PricingOverride = { products: {} };
  if (root) {
    for (const key of Object.keys(root)) {
      if (!['name', 'source', 'retrieved', 'discountPercent', 'notes', 'products', 'currency', '$schema', 'comment'].includes(key)) {
        issues.add(key, `unknown field (allowed: name, source, retrieved, discountPercent, notes, products)`);
      }
    }
    if (root.currency !== undefined && root.currency !== 'USD') issues.add('currency', 'only USD is supported');
    const name = issues.nullableString(root.name, 'name', 200);
    if (name) result.name = name;
    const source = issues.nullableString(root.source, 'source', 500);
    if (source) result.source = source;
    const retrieved = issues.nullableString(root.retrieved, 'retrieved', 40);
    if (retrieved) result.retrieved = retrieved;
    if (root.discountPercent !== undefined && root.discountPercent !== null) {
      const d = issues.numberInRange(root.discountPercent, 'discountPercent', 0, 100);
      if (d !== null) result.discountPercent = d;
    }
    const notes = issues.optionalArray(root.notes, 'notes', 50);
    if (notes) {
      result.notes = [];
      notes.forEach((n, i) => {
        const s = issues.string(n, `notes[${i}]`, 500);
        if (s) result.notes?.push(s);
      });
    }
    const products = issues.optionalRecord(root.products, 'products');
    if (products) {
      for (const [key, value] of Object.entries(products)) {
        const path = `products.${key}`;
        if (!isProductKey(key)) {
          issues.add(path, `unknown product (allowed: ${PRODUCT_KEYS.join(', ')})`);
          continue;
        }
        const product = parseProductOverride(value, path, issues);
        if (product) result.products[key] = product;
      }
    }
  }
  issues.throwIfAny(what);
  return result;
}

function parseProductOverride(value: unknown, path: string, issues: Issues): ProductOverride | null {
  const obj = issues.record(value, path);
  if (!obj) return null;
  if (!('tiers' in obj)) {
    issues.add(`${path}.tiers`, 'required (an array of tiers, or null to mark the price as unverified)');
    return null;
  }
  const override: ProductOverride = { tiers: null };
  const label = issues.nullableString(obj.label, `${path}.label`, 200);
  if (label) override.label = label;
  if (obj.freeAllowance !== undefined && obj.freeAllowance !== null) {
    const free = issues.count(obj.freeAllowance, `${path}.freeAllowance`);
    if (free !== null) override.freeAllowance = free;
  }
  if (obj.tiers === null) {
    const reason = issues.nullableString(obj.unverifiedReason, `${path}.unverifiedReason`, 500);
    override.unverifiedReason = reason ?? 'Price marked as unknown in the pricing file';
    return override;
  }
  const rawTiers = issues.array(obj.tiers, `${path}.tiers`, 100);
  if (!rawTiers) return null;
  const tiers: PriceTier[] = [];
  rawTiers.forEach((raw, i) => {
    const tier = parseTier(raw, `${path}.tiers[${i}]`, issues);
    if (tier) tiers.push(tier);
  });
  if (tiers.length === rawTiers.length) {
    for (const problem of tierProblems(tiers, `${path}.tiers`)) issues.list.push(problem);
  }
  override.tiers = tiers;
  return override;
}

/**
 * Accepts HogPost's shape ({ upTo, unitUsd, flatUsd? }) and PostHog's billing API shape
 * ({ up_to, unit_amount_usd: "0.00005", flat_amount_usd: "0" }).
 */
export function parseTier(raw: unknown, path: string, issues: Issues): PriceTier | null {
  if (!isRecord(raw)) {
    issues.add(path, 'expected an object like { "upTo": 1000000, "unitUsd": 0.00005 }');
    return null;
  }
  const upToRaw = 'upTo' in raw ? raw.upTo : raw.up_to;
  const unitRaw = 'unitUsd' in raw ? raw.unitUsd : raw.unit_amount_usd;
  const flatRaw = 'flatUsd' in raw ? raw.flatUsd : raw.flat_amount_usd;
  let upTo: number | null = null;
  if (upToRaw !== null && upToRaw !== undefined) {
    const n = issues.count(toNumber(upToRaw), `${path}.upTo`);
    if (n === null) return null;
    upTo = n;
  }
  const unitUsd = issues.count(toNumber(unitRaw), `${path}.unitUsd`);
  if (unitUsd === null) return null;
  const tier: { upTo: number | null; unitUsd: number; flatUsd?: number } = { upTo, unitUsd };
  if (flatRaw !== undefined && flatRaw !== null) {
    const flat = issues.count(toNumber(flatRaw), `${path}.flatUsd`);
    if (flat === null) return null;
    if (flat > 0) tier.flatUsd = flat;
  }
  return tier;
}

function toNumber(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

export interface EffectivePricing {
  table: PricingTable;
  sources: Record<ProductKey, PriceSource>;
}

export function publicPricing(): EffectivePricing {
  const sources = {} as Record<ProductKey, PriceSource>;
  for (const key of PRODUCT_KEYS) sources[key] = 'public';
  return { table: PUBLIC_PRICING, sources };
}

/** Layers an override on top of an effective pricing table. */
export function applyPricingOverride(base: EffectivePricing, override: PricingOverride, source: PriceSource): EffectivePricing {
  const products = { ...base.table.products } as Record<ProductKey, ProductPricing>;
  const sources = { ...base.sources };
  for (const key of PRODUCT_KEYS) {
    const o = override.products[key];
    if (!o) continue;
    const previous = products[key];
    const freeAllowance = o.freeAllowance ?? (o.tiers ? freeUnitsFromTiers(o.tiers) : previous.freeAllowance);
    const next: ProductPricing = {
      label: o.label ?? previous.label,
      unit: previous.unit,
      unitPlural: previous.unitPlural,
      freeAllowance: Number.isFinite(freeAllowance) ? freeAllowance : previous.freeAllowance,
      tiers: o.tiers,
      ...(o.tiers === null ? { unverifiedReason: o.unverifiedReason ?? 'Marked as unknown' } : {}),
    };
    products[key] = next;
    sources[key] = source;
  }
  const notes = [...base.table.notes, ...(override.notes ?? [])];
  const discount = override.discountPercent ?? base.table.discountPercent;
  const table: PricingTable = {
    name: source === 'override' ? (override.name ?? 'Custom pricing (--pricing file)') : base.table.name,
    source: source === 'override' ? (override.source ?? 'pricing override file') : base.table.source,
    retrieved: source === 'override' ? (override.retrieved ?? base.table.retrieved) : base.table.retrieved,
    currency: 'USD',
    ...(discount !== undefined ? { discountPercent: discount } : {}),
    notes,
    products,
  };
  return { table, sources };
}

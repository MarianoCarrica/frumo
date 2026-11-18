import type { CostLine } from '../analysis/model.js';

/** Meters whose absence is worth flagging as "unknown" in the bill (the others are simply omitted). */
const CORE_METERS: ReadonlySet<string> = new Set(['events', 'identifiedEvents', 'recordings', 'flagRequests']);

/** Bill lines to show: everything with usage, plus core meters whose usage is unknown. */
export function visibleBillLines(lines: readonly CostLine[]): CostLine[] {
  return lines.filter((l) => (l.units ?? 0) > 0 || (l.missing === 'usage-unknown' && CORE_METERS.has(l.usageKey)));
}

const intl0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const intl1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const intl2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,456", "$12", "$4.37", "$0". null → "n/a". */
export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs === 0) return '$0';
  if (abs < 10) return `${sign}$${intl2.format(abs)}`;
  return `${sign}$${intl0.format(Math.round(abs))}`;
}

/** Compact counts: 9.3M, 64.2K, 880. */
export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}M`;
  if (abs >= 10_000) return `${sign}${trim(abs / 1_000)}K`;
  return `${sign}${intl0.format(Math.round(abs))}`;
}

function trim(n: number): string {
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return Number(n.toFixed(digits)).toString();
}

/** Exact counts with separators: 3,620,000 */
export function exact(value: number): string {
  return intl0.format(Math.round(value));
}

/** 0.312 → "31%", 0.042 → "4.2%", 0.0004 → "<0.1%" */
export function pct(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return 'n/a';
  const p = fraction * 100;
  if (p === 0) return '0%';
  if (Math.abs(p) < 0.1) return '<0.1%';
  if (Math.abs(p) < 10) return `${intl1.format(p)}%`;
  return `${intl0.format(Math.round(p))}%`;
}

/** A reduction as a negative percentage ("−61%"), or "0%" when there is none. */
export function minusPct(fraction: number): string {
  return fraction > 0 ? `−${pct(fraction)}` : '0%';
}

/** The bill total, or "n/a" when no product has both known usage and a verified price. */
export function totalText(result: { costs: { lines: ReadonlyArray<{ usd: number | null }>; totalUsd: number } }): string {
  return result.costs.lines.some((l) => l.usd !== null) ? usd(result.costs.totalUsd) : 'n/a';
}

/** Price per unit with enough precision: 0.0000343 → "$0.0000343" */
export function unitPrice(value: number): string {
  if (value === 0) return '$0';
  return `$${value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return Math.round(n) === 1 ? singular : pluralForm;
}

/** Truncates long strings for tables. */
export function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

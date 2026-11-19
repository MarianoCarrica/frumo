/**
 * frumo as a library. Unofficial; not affiliated with or endorsed by PostHog Inc.
 * The CLI (src/cli.ts) is a thin wrapper around these.
 */
export { runAnalysis, DISCLAIMER, niceLimit } from './analysis/index.js';
export type { AnalysisOptions } from './analysis/index.js';
export type { AuditResult, Driver, Fix, FixResult, CostBreakdown, BillingLimitSuggestion } from './analysis/model.js';
export { PUBLIC_PRICING } from './pricing/public-pricing.js';
export { tieredCost, averageUnitCost, marginalUnitCost } from './pricing/math.js';
export { parsePricingOverride } from './pricing/override.js';
export type { PricingTable, PriceTier, ProductKey } from './pricing/types.js';
export { parseSnapshot, SNAPSHOT_SCHEMA } from './snapshot.js';
export type { Snapshot } from './snapshot.js';
export { renderHtml } from './report/html.js';
export { renderJson } from './report/json.js';
export { renderTerminal } from './report/terminal.js';
export { readDemoSnapshot, readInputFile } from './sources/file.js';
export { PostHogReadOnlyClient } from './sources/live/client.js';
export { collectSnapshot } from './sources/live/collect.js';
export { buildQueries } from './sources/live/queries.js';
export { VERSION } from './version.js';

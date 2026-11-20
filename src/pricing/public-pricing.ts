/**
 * PostHog public usage pricing: the ONLY file in frumo that contains prices.
 *
 * Source:    https://posthog.com/pricing  ("See all products and per-unit rates")
 * Retrieved: 2026-11-18
 *
 * How the numbers were read: the pricing page renders its per-unit rate tables from PostHog's
 * billing product catalogue, which the site publishes as static JSON alongside the page. The tiers
 * below were copied from that catalogue and cross-checked against:
 *   - https://posthog.com/docs/product-analytics/pricing       (event tiers)
 *   - https://posthog.com/docs/feature-flags/cutting-costs      (flag request tiers)
 *   - https://posthog.com/docs/error-tracking/pricing           (exception tiers)
 *   - https://posthog.com/blog/analytics-pricing                (identified = base rate + person-profile add-on)
 *   - the free allowances listed on https://posthog.com/pricing (1M events, 5K recordings,
 *     1M flag requests, 1,500 survey responses, 100K exceptions)
 *
 * Billing rules encoded here (from PostHog docs/blog):
 *   - Every billable event is charged the "product_analytics" rate. Identified events (events that
 *     create/update a person profile) are additionally charged the "identified_events" add-on rate,
 *     shown as "Person profiles" on the invoice. Both have their own 1M free allowance.
 *   - Tiers are graduated: each unit is charged at the rate of the tier it falls in.
 *   - Usage and free allowances are organization-wide (all projects share them).
 *
 * If PostHog changes prices, update this file (and `retrieved`), or pass `--pricing <file>`.
 * Never guess a number: if a price can't be verified, set `tiers: null` and an `unverifiedReason`;
 * frumo then reports volumes without a dollar figure for that product.
 */
import type { PriceTier, PricingTable, SentryPricingTable } from './types.js';

export const PUBLIC_PRICING: PricingTable = {
  name: 'PostHog public pricing',
  source: 'https://posthog.com/pricing',
  retrieved: '2026-11-18',
  currency: 'USD',
  notes: [
    'Pay-as-you-go list prices in USD, excluding taxes. Annual plans, volume discounts, startup credits and custom contracts are not reflected; use --pricing <file> for those.',
    'Identified events are charged the base event rate plus the person-profile add-on rate.',
  ],
  products: {
    product_analytics: {
      label: 'Product analytics events',
      unit: 'event',
      unitPlural: 'events',
      freeAllowance: 1_000_000,
      planKey: 'paid-20261105',
      tiers: [
        { upTo: 1_000_000, unitUsd: 0 },
        { upTo: 2_000_000, unitUsd: 0.00005 },
        { upTo: 15_000_000, unitUsd: 0.0000343 },
        { upTo: 50_000_000, unitUsd: 0.0000295 },
        { upTo: 100_000_000, unitUsd: 0.0000218 },
        { upTo: 250_000_000, unitUsd: 0.000015 },
        { upTo: null, unitUsd: 0.000009 },
      ],
      verifiedFrom: ['https://posthog.com/pricing', 'https://posthog.com/docs/product-analytics/pricing'],
    },
    identified_events: {
      label: 'Person profiles (identified events add-on)',
      unit: 'identified event',
      unitPlural: 'identified events',
      freeAllowance: 1_000_000,
      planKey: 'addon-20240404',
      tiers: [
        { upTo: 1_000_000, unitUsd: 0 },
        { upTo: 2_000_000, unitUsd: 0.000198 },
        { upTo: 15_000_000, unitUsd: 0.0000697 },
        { upTo: 50_000_000, unitUsd: 0.000036 },
        { upTo: 100_000_000, unitUsd: 0.0000146 },
        { upTo: 250_000_000, unitUsd: 0.0000037 },
        { upTo: null, unitUsd: 0.000001 },
      ],
      verifiedFrom: ['https://posthog.com/pricing', 'https://posthog.com/blog/analytics-pricing'],
    },
    session_replay: {
      label: 'Session replay (web recordings)',
      unit: 'recording',
      unitPlural: 'recordings',
      freeAllowance: 5_000,
      planKey: 'paid-20240402-5k-free',
      tiers: [
        { upTo: 5_000, unitUsd: 0 },
        { upTo: 15_000, unitUsd: 0.005 },
        { upTo: 50_000, unitUsd: 0.0035 },
        { upTo: 150_000, unitUsd: 0.002 },
        { upTo: 500_000, unitUsd: 0.0017 },
        { upTo: null, unitUsd: 0.0015 },
      ],
      verifiedFrom: ['https://posthog.com/pricing'],
    },
    mobile_replay: {
      label: 'Session replay (mobile recordings)',
      unit: 'mobile recording',
      unitPlural: 'mobile recordings',
      freeAllowance: 2_500,
      planKey: 'addon-20250106',
      tiers: [
        { upTo: 2_500, unitUsd: 0 },
        { upTo: 15_000, unitUsd: 0.01 },
        { upTo: 50_000, unitUsd: 0.007 },
        { upTo: 150_000, unitUsd: 0.004 },
        { upTo: 500_000, unitUsd: 0.0034 },
        { upTo: null, unitUsd: 0.003 },
      ],
      verifiedFrom: ['https://posthog.com/pricing'],
    },
    feature_flags: {
      label: 'Feature flags & experiments',
      unit: 'flag request',
      unitPlural: 'flag requests',
      freeAllowance: 1_000_000,
      planKey: 'paid-20230623',
      tiers: [
        { upTo: 1_000_000, unitUsd: 0 },
        { upTo: 2_000_000, unitUsd: 0.0001 },
        { upTo: 10_000_000, unitUsd: 0.000045 },
        { upTo: 50_000_000, unitUsd: 0.000025 },
        { upTo: null, unitUsd: 0.00001 },
      ],
      verifiedFrom: ['https://posthog.com/pricing', 'https://posthog.com/docs/feature-flags/cutting-costs'],
    },
    surveys: {
      label: 'Surveys',
      unit: 'survey response',
      unitPlural: 'survey responses',
      freeAllowance: 1_500,
      planKey: 'paid-20250801',
      tiers: [
        { upTo: 1_500, unitUsd: 0 },
        { upTo: 2_000, unitUsd: 0.1 },
        { upTo: 10_000, unitUsd: 0.035 },
        { upTo: 20_000, unitUsd: 0.015 },
        { upTo: null, unitUsd: 0.01 },
      ],
      verifiedFrom: ['https://posthog.com/pricing'],
    },
    error_tracking: {
      label: 'Error tracking',
      unit: 'exception',
      unitPlural: 'exceptions',
      freeAllowance: 100_000,
      planKey: 'paid-20250422',
      tiers: [
        { upTo: 100_000, unitUsd: 0 },
        { upTo: 325_000, unitUsd: 0.00037 },
        { upTo: 10_000_000, unitUsd: 0.00014 },
        { upTo: null, unitUsd: 0.000115 },
      ],
      verifiedFrom: ['https://posthog.com/pricing', 'https://posthog.com/docs/error-tracking/pricing'],
    },
  },
};

/**
 * Sentry public pay-as-you-go pricing (used by `frumo sentry`). Kept in this file so every
 * price in frumo lives in one place (test/repo-rules.test.ts).
 *
 * Sources checked 2026-11-20:
 *   - https://docs.sentry.io/pricing/   (PAYG bands per plan)
 *   - https://sentry.io/pricing/        (included volume on Team and Business)
 *
 * Included each month on Team and Business: 50K errors, 5M spans, 50 replays, 1 GB attachments.
 * Bands are graduated: each unit is charged at the rate of the band it falls in. Reserved volume,
 * mid-cycle plan changes and Enterprise contracts are not modelled.
 */
/** Sentry replays cost the same on Team and Business. */
const SENTRY_REPLAY_TIERS: readonly PriceTier[] = [
  { upTo: 50, unitUsd: 0 },
  { upTo: 5_000, unitUsd: 0.00375 },
  { upTo: 100_000, unitUsd: 0.003563 },
  { upTo: 900_000, unitUsd: 0.003206 },
  { upTo: 4_500_000, unitUsd: 0.002886 },
  { upTo: null, unitUsd: 0.002453 },
];

export const SENTRY_PUBLIC_PRICING: SentryPricingTable = {
  name: 'Sentry public pay-as-you-go pricing',
  sources: ['https://docs.sentry.io/pricing/', 'https://sentry.io/pricing/'],
  retrieved: '2026-11-20',
  currency: 'USD',
  notes: [
    'Pay-as-you-go list prices in USD for volume above the plan\'s included quota. The plan subscription fee, reserved volume, discounts and Enterprise contracts are not included.',
  ],
  categories: {
    errors: {
      label: 'Errors',
      unit: 'error',
      unitPlural: 'errors',
      included: 50_000,
      tiers: {
        team: [
          { upTo: 50_000, unitUsd: 0 },
          { upTo: 100_000, unitUsd: 0.0003625 },
          { upTo: 500_000, unitUsd: 0.0002188 },
          { upTo: 10_000_000, unitUsd: 0.0001875 },
          { upTo: 20_000_000, unitUsd: 0.0001625 },
          { upTo: null, unitUsd: 0.00015 },
        ],
        business: [
          { upTo: 50_000, unitUsd: 0 },
          { upTo: 100_000, unitUsd: 0.0011125 },
          { upTo: 500_000, unitUsd: 0.000625 },
          { upTo: 10_000_000, unitUsd: 0.000375 },
          { upTo: 20_000_000, unitUsd: 0.000325 },
          { upTo: null, unitUsd: 0.0003 },
        ],
      },
    },
    spans: {
      label: 'Spans (tracing)',
      unit: 'span',
      unitPlural: 'spans',
      included: 5_000_000,
      tiers: {
        team: [
          { upTo: 5_000_000, unitUsd: 0 },
          { upTo: 100_000_000, unitUsd: 0.000002 },
          { upTo: null, unitUsd: 0.0000018 },
        ],
        business: [
          { upTo: 5_000_000, unitUsd: 0 },
          { upTo: 100_000_000, unitUsd: 0.000004 },
          { upTo: null, unitUsd: 0.0000036 },
        ],
      },
    },
    replays: {
      label: 'Session replays',
      unit: 'replay',
      unitPlural: 'replays',
      included: 50,
      tiers: {
        team: SENTRY_REPLAY_TIERS,
        business: SENTRY_REPLAY_TIERS,
      },
    },
    attachments: {
      label: 'Attachments',
      unit: 'GB',
      unitPlural: 'GB',
      included: 1,
      tiers: {
        team: [
          { upTo: 1, unitUsd: 0 },
          { upTo: null, unitUsd: 0.3125 },
        ],
        business: [
          { upTo: 1, unitUsd: 0 },
          { upTo: null, unitUsd: 0.3125 },
        ],
      },
    },
  },
};


/**
 * A fake PostHog API for tests: answers the endpoints eventspend calls with documented response
 * shapes. No network is involved; it plugs in as the client's fetch implementation.
 */
import { buildQueries } from '../src/sources/live/queries.js';
import type { RecordedCall } from './helpers.js';
import { json, mockFetch } from './helpers.js';

export const PROJECT = '123';
export const STAGING = '456';

const tier = (up_to: number | null, unit: string) => ({ up_to, unit_amount_usd: unit, flat_amount_usd: '0', current_amount_usd: '0.00', current_usage: 0 });

export const QUERY_RESULTS: Record<string, { columns: string[]; results: unknown[][] }> = {
  eventspend_totals: {
    columns: ['all_events', 'billable', 'billable_identified', 'unidentified_person_events'],
    results: [[3_300_000, 3_000_000, 1_500_000, 400_000]],
  },
  eventspend_events_by_name: {
    columns: ['event', 'total', 'identified'],
    results: [
      ['$autocapture', 1_500_000, 700_000],
      ['$pageview', 600_000, 300_000],
      ['$pageleave', 500_000, 250_000],
      ['api_request', 300_000, 250_000],
      ['$identify', 100_000, 100_000],
      ['$feature_flag_called', 300_000, 300_000],
    ],
  },
  eventspend_by_lib: { columns: ['lib', 'total', 'identified'], results: [['web', 2_700_000, 1_250_000], ['posthog-node', 300_000, 250_000]] },
  eventspend_by_host: {
    columns: ['host', 'total', 'identified'],
    results: [['app.acme.example', 1_700_000, 1_100_000], ['www.acme.example', 900_000, 400_000], ['localhost:3000', 100_000, 0]],
  },
  eventspend_by_page: {
    columns: ['host', 'path', 'total', 'identified', 'unidentified_person_events', 'pageviews', 'pageleaves', 'autocapture'],
    results: [
      ['app.acme.example', '/dashboard', 1_700_000, 1_100_000, 0, 300_000, 250_000, 800_000],
      ['www.acme.example', '/', 900_000, 400_000, 400_000, 250_000, 200_000, 600_000],
      ['localhost:3000', '/dashboard', 100_000, 0, 0, 50_000, 50_000, 0],
    ],
  },
  eventspend_autocapture_dom_events: {
    columns: ['dom_event', 'host', 'total'],
    results: [['click', 'app.acme.example', 600_000], ['change', 'app.acme.example', 200_000], ['click', 'www.acme.example', 600_000]],
  },
  eventspend_autocapture_elements: {
    columns: ['host', 'dom_event', 'tag', 'classes', 'text', 'total', 'sessions'],
    results: [['app.acme.example', 'click', 'button', '.grid-cell', '12', 300_000, 30_000], ['www.acme.example', 'click', 'a', '', 'Pricing', 100_000, 90_000]],
  },
  eventspend_identity: {
    columns: ['event', 'lib', 'total', 'necessary'],
    results: [['$identify', 'posthog-node', 90_000, 10_000], ['$identify', 'web', 10_000, 9_000]],
  },
  eventspend_bots: {
    columns: ['user_agent', 'lib', 'total', 'identified'],
    results: [['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'posthog-node', 50_000, 50_000]],
  },
  eventspend_server_events: {
    columns: ['lib', 'event', 'total', 'identified'],
    results: [['posthog-node', 'api_request', 300_000, 250_000]],
  },
  eventspend_flags_called: {
    columns: ['lib', 'locally_evaluated', 'total', 'flags'],
    results: [['posthog-node', 'false', 200_000, 4], ['web', null, 100_000, 3]],
  },
  eventspend_replay_summary: {
    columns: ['recordings', 'under_5s', 'under_10s', 'under_30s', 'under_60s', 'active_under_5s'],
    results: [[30_000, 9_000, 12_000, 18_000, 21_000, 15_000]],
  },
  eventspend_replay_first_urls: {
    columns: ['url', 'total', 'under_5s', 'single_url'],
    results: [['https://www.acme.example/', 15_000, 6_000, 10_000], ['https://app.acme.example/dashboard', 15_000, 3_000, 2_000]],
  },
};

export interface FakeOptions {
  /** Status to return for specific paths (e.g. 403 for billing). */
  failPaths?: Record<string, number>;
  /** Query names that fail with a 400. */
  failQueries?: string[];
}

export function fakePostHog(options: FakeOptions = {}) {
  const registered = new Set(buildQueries(30).map((q) => q.sql));
  const route = (call: RecordedCall): Response => {
    const path = call.url.pathname;
    for (const [failPath, status] of Object.entries(options.failPaths ?? {})) {
      if (path === failPath) return json({ type: 'authentication_error', code: 'permission_denied', detail: 'You do not have permission.' }, status);
    }
    if (call.method === 'POST' && path === `/api/projects/${PROJECT}/query/`) {
      const body = JSON.parse(call.body ?? '{}') as { name: string; query: { kind: string; query: string } };
      if (body.query.kind !== 'HogQLQuery' || !registered.has(body.query.query)) return json({ detail: 'unexpected query' }, 400);
      if (options.failQueries?.includes(body.name)) return json({ type: 'validation_error', code: 'query_error', detail: `Unknown table in ${body.name}` }, 400);
      const result = QUERY_RESULTS[body.name];
      return result ? json({ ...result, is_cached: false }) : json({ detail: 'unknown' }, 400);
    }
    if (call.method !== 'GET') return json({ detail: 'method not allowed' }, 405);
    switch (path) {
      case `/api/projects/${PROJECT}/`:
        return json({
          id: Number(PROJECT),
          name: 'Acme Production',
          autocapture_opt_out: false,
          session_recording_opt_in: true,
          session_recording_sample_rate: '1.00',
          session_recording_minimum_duration_milliseconds: null,
          session_recording_url_trigger_config: [],
          session_recording_trigger_groups: [],
          heatmaps_opt_in: true,
          capture_dead_clicks: true,
        });
      case '/api/billing/':
        return json({
          customer_id: 'cus_1',
          has_active_subscription: true,
          discount_percent: null,
          projected_total_amount_usd: '812.50',
          custom_limits_usd: { product_analytics: 500, session_replay: null },
          billing_period: { current_period_start: '2026-11-01T00:00:00Z', current_period_end: '2026-12-01T00:00:00Z', interval: 'month' },
          products: [
            {
              type: 'product_analytics',
              subscribed: true,
              tiers: [tier(1_000_000, '0'), tier(2_000_000, '0.00004'), tier(null, '0.00003')],
              addons: [{ type: 'enhanced_persons', subscribed: true, tiers: [tier(1_000_000, '0'), tier(null, '0.0001')] }],
            },
            { type: 'session_replay', subscribed: true, tiers: null, addons: [] },
            { type: 'feature_flags', subscribed: true, tiers: [{ weird: true }], addons: [] },
          ],
        });
      case '/api/billing/usage/': {
        const series = (type: string, team: string, values: number[]) => ({
          id: 1,
          label: `${type}::${team}`,
          data: values,
          dates: values.map((_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`),
          breakdown_type: 'multiple',
          breakdown_value: [type, Number(team)],
        });
        return json({
          status: 'ok',
          type: 'timeseries',
          results: [
            series('event_count_in_period', PROJECT, [1_500_000, 1_500_000]),
            series('enhanced_persons_event_count_in_period', PROJECT, [750_000, 750_000]),
            series('recording_count_in_period', PROJECT, [15_000, 15_000]),
            series('billable_feature_flag_requests_count_in_period', PROJECT, [2_000_000, 2_000_000]),
            series('event_count_in_period', STAGING, [400_000, 400_000]),
            series('billable_feature_flag_requests_count_in_period', STAGING, [500_000, 500_000]),
            series('some_future_usage_in_period', PROJECT, [1]),
          ],
        });
      }
      case '/api/organizations/@current/projects/':
        return json({ results: [{ id: Number(PROJECT), name: 'Acme Production' }, { id: Number(STAGING), name: 'Acme Staging' }] });
      case `/api/projects/${PROJECT}/feature_flags/`: {
        const second = call.url.searchParams.get('offset') === '200';
        return json(
          second
            ? { count: 3, next: null, results: [{ key: 'old-flag', active: true, ensure_experience_continuity: false, filters: {}, last_called_at: '2025-01-01T00:00:00Z' }] }
            : {
                count: 3,
                next: `https://us.posthog.com/api/projects/${PROJECT}/feature_flags/?active=true&limit=200&offset=200`,
                results: [
                  { key: 'new-billing', active: true, ensure_experience_continuity: true, filters: { groups: [] }, evaluation_runtime: 'server', last_called_at: '2026-11-17T00:00:00Z' },
                  { key: 'sso', active: true, filters: { groups: [{ properties: [{ key: 'email', operator: 'is_not_set', type: 'person' }] }] }, last_called_at: '2026-11-17T00:00:00Z' },
                ],
              },
        );
      }
      default:
        return json({ detail: 'Not found.' }, 404);
    }
  };
  return mockFetch(route);
}

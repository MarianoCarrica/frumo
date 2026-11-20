/**
 * A fake Sentry API for live-mode tests: answers the GETs `frumo sentry` makes from a small
 * fictional org. The client-keys payload deliberately includes DSNs and key secrets, which
 * must never reach a snapshot or report.
 */
import { json, mockFetch } from './helpers.js';
import type { RecordedCall } from './helpers.js';

export const ORG = 'fernhollow';
export const SENTRY_TOKEN = 'sntryu_FAKETOKEN0123456789abcdefABCDEF0123456789abcdef';

/** Strings from the fake keys payload that must never be printed, logged or saved. */
export const KEY_SECRETS = {
  publicKey: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  secretKey: 'f0e9d8c7b6a5948372615049382716ab',
  dsnPublic: 'https://a1b2c3d4e5f60718293a4b5c6d7e8f90@o0.ingest.fernhollow.example/4242',
  dsnSecret: 'https://a1b2c3d4e5f60718293a4b5c6d7e8f90:f0e9d8c7b6a5948372615049382716ab@o0.ingest.fernhollow.example/4242',
  dsnCsp: 'https://o0.ingest.fernhollow.example/api/4242/security/?sentry_key=a1b2c3d4e5f60718293a4b5c6d7e8f90',
} as const;

const PROJECTS = [
  { id: '4242', slug: 'storefront', name: 'Storefront', platform: 'javascript-vue' },
  { id: '4243', slug: 'orders-api', name: 'Orders API', platform: 'node' },
];

/** Volume per category for 30 days: [project, outcome, quantity]. */
const STATS: Record<string, Array<[number, string, number]>> = {
  error: [
    [4242, 'accepted', 900_000],
    [4242, 'filtered', 10_000],
    [4243, 'accepted', 100_000],
    [4243, 'rate_limited', 5_000],
  ],
  transaction: [[4242, 'accepted', 12_000_000]],
  replay: [[4242, 'accepted', 2_000]],
  attachment: [],
};

const ISSUES = [
  {
    id: '7001',
    shortId: 'STOREFRONT-1',
    title: 'ResizeObserver loop limit exceeded',
    culprit: 'src/components/Grid.vue',
    count: '300000',
    status: 'ignored',
    substatus: 'archived_forever',
    project: { id: '4242', slug: 'storefront', name: 'Storefront' },
    level: 'error',
    metadata: { value: 'ResizeObserver loop limit exceeded' },
  },
  {
    id: '7002',
    shortId: 'STOREFRONT-2',
    title: "TypeError: Cannot read properties of null (reading 'style')",
    culprit: 'moz-extension://0d5d6f7e-1111-2222-3333-444455556666/inject.js',
    count: '120000',
    status: 'unresolved',
    substatus: 'ongoing',
    project: { id: '4242', slug: 'storefront', name: 'Storefront' },
    level: 'error',
  },
  {
    id: '7003',
    shortId: 'ORDERS-API-1',
    title: 'Error: Request timed out',
    culprit: 'lib/payments',
    count: '20000',
    status: 'unresolved',
    substatus: 'ongoing',
    project: { id: '4243', slug: 'orders-api', name: 'Orders API' },
    level: 'error',
  },
];

function keysFor(projectId: string, rateLimit: { window: number; count: number } | null) {
  return [
    {
      id: KEY_SECRETS.publicKey,
      name: 'Default',
      label: 'Default',
      public: KEY_SECRETS.publicKey,
      secret: KEY_SECRETS.secretKey,
      projectId: Number(projectId),
      isActive: true,
      rateLimit,
      dsn: { secret: KEY_SECRETS.dsnSecret, public: KEY_SECRETS.dsnPublic, csp: KEY_SECRETS.dsnCsp },
      browserSdkVersion: '8.x',
      dateCreated: '2026-01-01T00:00:00Z',
    },
  ];
}

export interface FakeSentryOptions {
  /** Status to answer for every request (e.g. 401). */
  failAll?: number;
}

export function fakeSentry(options: FakeSentryOptions = {}) {
  return mockFetch((call: RecordedCall) => {
    if (options.failAll) return json({ detail: 'Invalid token' }, options.failAll);
    if (call.method !== 'GET') return json({ detail: 'method not allowed' }, 405);
    const path = call.url.pathname;
    if (path === `/api/0/organizations/${ORG}/projects/`) return json(PROJECTS);
    if (path === `/api/0/organizations/${ORG}/stats_v2/`) {
      const category = call.url.searchParams.get('category') ?? '';
      const rows = STATS[category];
      if (!rows) return json({ detail: 'bad category' }, 400);
      return json({
        start: '2026-10-21T00:00:00Z',
        end: '2026-11-20T00:00:00Z',
        intervals: [],
        groups: rows.map(([project, outcome, quantity]) => ({ by: { project, outcome }, totals: { 'sum(quantity)': quantity }, series: {} })),
      });
    }
    if (path === `/api/0/organizations/${ORG}/issues/`) {
      return json(ISSUES, 200, {
        link: `<https://sentry.io/api/0/organizations/${ORG}/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/${ORG}/issues/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"`,
      });
    }
    if (path === `/api/0/projects/${ORG}/storefront/filters/`) {
      return json([
        { id: 'browser-extensions', active: false },
        { id: 'localhost', active: true },
        { id: 'web-crawlers', active: true },
        { id: 'legacy-browsers', active: ['ie_pre_9'] },
        { id: 'filtered-transaction', active: true },
      ]);
    }
    if (path === `/api/0/projects/${ORG}/orders-api/filters/`) {
      return json([
        { id: 'localhost', active: true },
        { id: 'filtered-transaction', active: true },
      ]);
    }
    if (path === `/api/0/projects/${ORG}/storefront/keys/`) return json(keysFor('4242', null));
    if (path === `/api/0/projects/${ORG}/orders-api/keys/`) return json(keysFor('4243', { window: 60, count: 500 }));
    return json({ detail: 'not found' }, 404);
  });
}

#!/usr/bin/env node
/**
 * Generates fixtures/demo-snapshot.json: 30 days of usage for "Tidebrook", a FICTIONAL B2B SaaS.
 * Every number is invented. Hosts use the reserved .example TLD.
 *
 * The story (each part maps to an analyzer):
 *   - ~8M events/month, with an autocapture spike from a hero carousel and a data grid
 *   - the marketing site uses an old snippet with person_profiles: 'always'
 *   - posthog-node calls identify() and $set on every API request and checks flags remotely
 *   - group() runs on every route change
 *   - a synthetic-monitoring tool logs in every minute; server-side pageview capture records crawlers
 *   - localhost, a Vercel preview and the staging frontend send to the production project
 *   - a separate staging project shares the organization's allowance
 *   - every session is recorded (no sampling, no minimum duration); a third are under 5 seconds
 *
 * Tables are aggregated from one list of segments, so they stay consistent with each other.
 * Run: node scripts/make-demo-fixture.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NON_BILLABLE = new Set(['$feature_flag_called', '$experiment_exposure', 'survey sent', 'survey shown', 'survey dismissed', '$exception']);
const isBillable = (event) => !NON_BILLABLE.has(event) && !event.startsWith('$ai_');
const SERVER_LIBS = new Set(['posthog-node', 'posthog-python']);

const WWW = 'www.tidebrook.example';
const DOCS = 'docs.tidebrook.example';
const APP = 'app.tidebrook.example';
const CHECKLY_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Checkly/2.4 (https://www.checklyhq.com)';
const AHREFS_UA = 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)';
const GOOGLEBOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/131.0.6778.69 Safari/537.36';
const PY_UA = 'python-requests/2.32.3';

/** Autocapture split by DOM event, per kind of page. */
const DOM_SPLIT = {
  marketing: { click: 0.97, change: 0.01, submit: 0.02 },
  docs: { click: 0.99, change: 0.01, submit: 0 },
  app: { click: 0.8, change: 0.17, submit: 0.03 },
  monitor: { click: 1, change: 0, submit: 0 },
};

// identified: share of events processed with a person profile.
// unidentified: share of those identified events where posthog-js said $is_identified=false.
// necessary: for identity events, share that were not repeats (session/user/day/group).
const segments = [
  // Marketing site: old snippet with person_profiles: 'always'
  { host: WWW, path: '/', lib: 'web', kind: 'marketing', identified: 0.56, unidentified: 0.93, events: { $pageview: 262000, $pageleave: 218000, $autocapture: 820000, $web_vitals: 41000, $dead_click: 23000, $rageclick: 6000 } },
  { host: WWW, path: '/pricing', lib: 'web', kind: 'marketing', identified: 0.58, unidentified: 0.9, events: { $pageview: 91000, $pageleave: 77000, $autocapture: 171000, $web_vitals: 14000, $dead_click: 7000 } },
  { host: WWW, path: '/blog/how-we-cut-churn-in-half', lib: 'web', kind: 'marketing', identified: 0.52, unidentified: 0.95, events: { $pageview: 52000, $pageleave: 44000, $autocapture: 38000, $web_vitals: 8000 } },
  { host: WWW, path: '/blog/q3-product-update', lib: 'web', kind: 'marketing', identified: 0.6, unidentified: 0.88, events: { $pageview: 31000, $pageleave: 27000, $autocapture: 21000 } },
  { host: WWW, path: '/blog', lib: 'web', kind: 'marketing', identified: 0.55, unidentified: 0.94, events: { $pageview: 24000, $pageleave: 20000, $autocapture: 33000 } },
  { host: WWW, path: '/customers', lib: 'web', kind: 'marketing', identified: 0.57, unidentified: 0.92, events: { $pageview: 18000, $pageleave: 15000, $autocapture: 26000 } },
  { host: WWW, path: '/changelog', lib: 'web', kind: 'marketing', identified: 0.7, unidentified: 0.6, events: { $pageview: 16000, $pageleave: 14000, $autocapture: 12000 } },
  { host: WWW, path: '/careers', lib: 'web', kind: 'marketing', identified: 0.5, unidentified: 0.97, events: { $pageview: 12000, $pageleave: 10000, $autocapture: 9000 } },
  { host: WWW, path: '/compare/acme-analytics', lib: 'web', kind: 'marketing', identified: 0.55, unidentified: 0.95, events: { $pageview: 9000, $pageleave: 8000, $autocapture: 14000 } },
  // Docs: default identified_only; logged-in customers stay identified
  { host: DOCS, path: '/getting-started', lib: 'web', kind: 'docs', identified: 0.22, unidentified: 0, events: { $pageview: 46000, $pageleave: 39000, $autocapture: 61000 } },
  { host: DOCS, path: '/api/reference', lib: 'web', kind: 'docs', identified: 0.31, unidentified: 0, events: { $pageview: 52000, $pageleave: 44000, $autocapture: 47000 } },
  { host: DOCS, path: '/', lib: 'web', kind: 'docs', identified: 0.18, unidentified: 0, events: { $pageview: 23000, $pageleave: 19000, $autocapture: 18000 } },
  // App: identified after login; group() on every route change
  { host: APP, path: '/dashboard', lib: 'web', kind: 'app', identified: 0.98, unidentified: 0, events: { $pageview: 214000, $pageleave: 181000, $autocapture: 1050000, $web_vitals: 31000, $dead_click: 18000, $rageclick: 9000, $groupidentify: 92000, dashboard_viewed: 248000, search_performed: 96000, feature_used: 158000 }, necessary: { $groupidentify: 0.25 } },
  { host: APP, path: '/reports/8812', lib: 'web', kind: 'app', identified: 0.99, unidentified: 0, events: { $pageview: 41000, $pageleave: 35000, $autocapture: 166000, filter_applied: 38000, report_viewed: 96000 } },
  { host: APP, path: '/reports/9031', lib: 'web', kind: 'app', identified: 0.99, unidentified: 0, events: { $pageview: 24000, $pageleave: 20000, $autocapture: 97000, filter_applied: 21000, report_viewed: 52000 } },
  { host: APP, path: '/reports/7744', lib: 'web', kind: 'app', identified: 0.99, unidentified: 0, events: { $pageview: 15000, $pageleave: 13000, $autocapture: 61000, filter_applied: 12000, report_viewed: 31000 } },
  { host: APP, path: '/settings/billing', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 12000, $pageleave: 10000, $autocapture: 41000 } },
  { host: APP, path: '/login', lib: 'web', kind: 'app', identified: 0.62, unidentified: 0, events: { $pageview: 38000, $pageleave: 6000, $autocapture: 51000, $identify: 41000 }, necessary: { $identify: 0.9 } },
  { host: APP, path: '/onboarding', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 9000, $autocapture: 37000, onboarding_step_completed: 26000, signup_completed: 3900 } },
  { host: APP, path: '/inbox', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 61000, $pageleave: 52000, $autocapture: 228000, $set: 64000, comment_added: 39000 }, necessary: { $set: 0.8 } },
  // Local, preview and staging frontends using the production project key
  { host: 'localhost:3000', path: '/dashboard', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 7000, $pageleave: 5000, $autocapture: 38000, dashboard_viewed: 6000 } },
  { host: 'tidebrook-git-feat-new-billing-tidebrook.vercel.app', path: '/settings/billing', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 4000, $pageleave: 3000, $autocapture: 19000 } },
  { host: 'staging.tidebrook.example', path: '/dashboard', lib: 'web', kind: 'app', identified: 1, unidentified: 0, events: { $pageview: 21000, $pageleave: 17000, $autocapture: 74000, dashboard_viewed: 9000 } },
  // Synthetic monitoring: logs in as a test user every minute
  { host: APP, path: '/login', lib: 'web', kind: 'monitor', ua: CHECKLY_UA, identified: 1, unidentified: 0, events: { $pageview: 43200, $autocapture: 43200, $identify: 43200 }, necessary: { $identify: 1 } },
  { host: APP, path: '/dashboard', lib: 'web', kind: 'monitor', ua: CHECKLY_UA, identified: 1, unidentified: 0, events: { $pageview: 43200, $pageleave: 43200 } },
  // Server-side pageview capture in middleware records crawlers (each gets a person profile)
  { host: WWW, path: '/blog/how-we-cut-churn-in-half', lib: 'posthog-node', kind: 'marketing', ua: AHREFS_UA, identified: 1, unidentified: 0, events: { $pageview: 38000 } },
  { host: WWW, path: '/pricing', lib: 'posthog-node', kind: 'marketing', ua: GOOGLEBOT_UA, identified: 1, unidentified: 0, events: { $pageview: 29000 } },
  { host: WWW, path: '/', lib: 'posthog-node', kind: 'marketing', ua: PY_UA, identified: 1, unidentified: 0, events: { $pageview: 12000 } },
  // Backend (no host)
  { host: null, path: null, lib: 'posthog-node', identified: 1, unidentified: 0, events: { api_request: 720000, $identify: 214000, $set: 150000, report_exported: 61000, invoice_paid: 2100, $feature_flag_called: 520000 }, necessary: { $identify: 0.145, $set: 0.16 } },
  { host: null, path: null, lib: 'posthog-python', identified: 1, unidentified: 0, events: { sync_job_completed: 182000, webhook_received: 54000, $feature_flag_called: 31000 } },
  // Not billed as analytics events
  { host: APP, path: '/dashboard', lib: 'web', kind: 'app', identified: 0.98, unidentified: 0, events: { $feature_flag_called: 122000, $exception: 44000, 'survey shown': 21000, 'survey sent': 880 } },
];

const FLAG_CALLED_LOCAL = { 'posthog-node': 'false', 'posthog-python': 'false', web: null };

const elements = [
  { host: WWW, domEvent: 'click', tag: 'button', classes: '.hero-carousel__next', text: 'Next', count: 540000, sessions: 61000 },
  { host: APP, domEvent: 'click', tag: 'button', classes: '.grid-cell', text: '$12,400', count: 640000, sessions: 52000 },
  { host: APP, domEvent: 'click', tag: 'button', classes: '.tab-trigger', text: 'Overview', count: 146000, sessions: 33000 },
  { host: APP, domEvent: 'click', tag: 'a', classes: '.sidebar-link', text: 'Reports', count: 121000, sessions: 48000 },
  { host: APP, domEvent: 'change', tag: 'input', classes: '.filter-input', text: null, count: 118000, sessions: 30000 },
  { host: APP, domEvent: 'click', tag: 'button', classes: '.icon-btn', text: null, count: 77000, sessions: 15000 },
  { host: APP, domEvent: 'change', tag: 'select', classes: '.form-select', text: null, count: 64000, sessions: 21000 },
  { host: WWW, domEvent: 'click', tag: 'a', classes: '.nav-link', text: 'Pricing', count: 58000, sessions: 51000 },
  { host: DOCS, domEvent: 'click', tag: 'a', classes: '.toc-link', text: 'Authentication', count: 52000, sessions: 22000 },
  { host: APP, domEvent: 'click', tag: 'button', classes: '.btn.btn-primary', text: 'Save changes', count: 39000, sessions: 21000 },
  { host: WWW, domEvent: 'click', tag: 'a', classes: '.btn.btn-primary', text: 'Start free trial', count: 31000, sessions: 27000 },
  { host: APP, domEvent: 'submit', tag: 'form', classes: '.login-form', text: null, count: 21000, sessions: 20500 },
];

// ---------------------------------------------------------------------------------------------
const round = Math.round;
const add = (map, key, init, fn) => {
  const cur = map.get(key) ?? init();
  fn(cur);
  map.set(key, cur);
};

const cells = [];
for (const seg of segments) {
  for (const [event, count] of Object.entries(seg.events)) {
    const identified = round(count * seg.identified);
    const unidentified = seg.lib === 'web' ? round(identified * seg.unidentified) : 0;
    const necessary = seg.necessary?.[event] !== undefined ? round(count * seg.necessary[event]) : null;
    cells.push({ ...seg, event, count, identified, unidentified, necessary, billable: isBillable(event) });
  }
}

const byEvent = new Map();
const byLib = new Map();
const byHost = new Map();
const byPage = new Map();
const domByHost = new Map();
const bots = new Map();
const serverEvents = new Map();
const identity = new Map();
const flagCalled = new Map();
let all = 0;
let billable = 0;
let billableIdentified = 0;
let unidentifiedPersonEvents = 0;

for (const c of cells) {
  all += c.count;
  add(byEvent, c.event, () => ({ event: c.event, count: 0, identified: 0 }), (r) => {
    r.count += c.count;
    r.identified += c.identified;
  });
  if (c.event === '$feature_flag_called') {
    add(flagCalled, c.lib, () => ({ lib: c.lib, locallyEvaluated: FLAG_CALLED_LOCAL[c.lib] ?? null, count: 0, flags: c.lib === 'web' ? 7 : c.lib === 'posthog-node' ? 9 : 2 }), (r) => {
      r.count += c.count;
    });
  }
  if (!c.billable) continue;
  billable += c.count;
  billableIdentified += c.identified;
  unidentifiedPersonEvents += c.unidentified;
  add(byLib, c.lib, () => ({ lib: c.lib, count: 0, identified: 0 }), (r) => {
    r.count += c.count;
    r.identified += c.identified;
  });
  if (c.host) {
    add(byHost, c.host, () => ({ host: c.host, count: 0, identified: 0 }), (r) => {
      r.count += c.count;
      r.identified += c.identified;
    });
    add(byPage, `${c.host}${c.path}`, () => ({ host: c.host, path: c.path, count: 0, identified: 0, unidentifiedPersonEvents: 0, pageviews: 0, pageleaves: 0, autocapture: 0 }), (r) => {
      r.count += c.count;
      r.identified += c.identified;
      r.unidentifiedPersonEvents += c.unidentified;
      if (c.event === '$pageview') r.pageviews += c.count;
      if (c.event === '$pageleave') r.pageleaves += c.count;
      if (c.event === '$autocapture') r.autocapture += c.count;
    });
    if (c.event === '$autocapture') {
      const split = DOM_SPLIT[c.kind] ?? DOM_SPLIT.app;
      for (const [dom, share] of Object.entries(split)) {
        if (share <= 0) continue;
        add(domByHost, `${dom}|${c.host}`, () => ({ domEvent: dom, host: c.host, count: 0 }), (r) => {
          r.count += round(c.count * share);
        });
      }
    }
  }
  if (c.ua) {
    add(bots, `${c.ua}|${c.lib}`, () => ({ userAgent: c.ua, lib: c.lib, count: 0, identified: 0 }), (r) => {
      r.count += c.count;
      r.identified += c.identified;
    });
  }
  if (SERVER_LIBS.has(c.lib)) {
    add(serverEvents, `${c.lib}|${c.event}`, () => ({ lib: c.lib, event: c.event, count: 0, identified: 0 }), (r) => {
      r.count += c.count;
      r.identified += c.identified;
    });
  }
  if (c.necessary !== null || ['$identify', '$set', '$groupidentify'].includes(c.event)) {
    add(identity, `${c.event}|${c.lib}`, () => ({ event: c.event, lib: c.lib, count: 0, necessary: 0 }), (r) => {
      r.count += c.count;
      r.necessary += c.necessary ?? c.count;
    });
  }
}

const desc = (a, b) => b.count - a.count;
const recordings = 64200;
const now = '2026-11-18T09:00:00.000Z';
const lastCalled = '2026-11-17T22:41:00.000Z';
const flag = (key, extra = {}) => ({
  key,
  active: true,
  ensureExperienceContinuity: false,
  usesStaticCohort: false,
  usesIsNotSet: false,
  evaluationRuntime: 'all',
  lastCalledAt: lastCalled,
  ...extra,
});

const snapshot = {
  schema: 'frumo.snapshot/v1',
  generatedAt: now,
  source: { kind: 'demo', host: null, toolVersion: '0.1.0', fictional: true, label: 'Tidebrook (fictional B2B SaaS)' },
  project: { id: '21345', name: 'Tidebrook (production)' },
  period: { days: 30, start: '2026-10-19T09:00:00.000Z', end: now },
  orgUsage: [
    {
      projectId: '21345',
      name: 'Tidebrook (production)',
      audited: true,
      usage: { events: billable, identifiedEvents: billableIdentified, recordings, mobileRecordings: 0, flagRequests: 9870000, surveyResponses: 880, exceptions: 44000 },
    },
    {
      projectId: '21346',
      name: 'Tidebrook (staging)',
      audited: false,
      usage: { events: 1060000, identifiedEvents: 640000, recordings: 8400, mobileRecordings: 0, flagRequests: 1450000, surveyResponses: 0, exceptions: 12000 },
    },
  ],
  projectSettings: {
    autocaptureOptOut: false,
    sessionRecordingOptIn: true,
    sessionRecordingSampleRate: null,
    sessionRecordingMinimumDurationMs: null,
    sessionRecordingUrlTriggerCount: 0,
    sessionRecordingTriggerGroupCount: 0,
    heatmapsOptIn: false,
    captureDeadClicks: true,
  },
  events: {
    totals: { all, billable, billableIdentified, unidentifiedPersonEvents },
    byEvent: [...byEvent.values()].sort(desc),
    byLib: [...byLib.values()].sort(desc),
    byHost: [...byHost.values()].sort(desc),
    byPage: [...byPage.values()].sort(desc),
    autocaptureDomEvents: [...domByHost.values()].sort(desc),
    autocaptureElements: elements,
    identity: [...identity.values()].sort(desc),
    bots: [...bots.values()].sort(desc),
    serverEvents: [...serverEvents.values()].sort(desc),
  },
  replay: {
    recordings,
    durations: { under5s: 19900, under10s: 26400, under30s: 35800, under60s: 41600 },
    activeUnder5s: 27100,
    byFirstUrl: [
      { url: `https://${WWW}/`, count: 18400, under5s: 7600, singleUrl: 11900 },
      { url: `https://${APP}/dashboard`, count: 14600, under5s: 2100, singleUrl: 1900 },
      { url: `https://${WWW}/pricing`, count: 6900, under5s: 2200, singleUrl: 3800 },
      { url: `https://${APP}/login`, count: 6300, under5s: 1800, singleUrl: 900 },
      { url: `https://${WWW}/blog/how-we-cut-churn-in-half`, count: 4100, under5s: 1900, singleUrl: 3300 },
      { url: `https://${APP}/inbox`, count: 2900, under5s: 500, singleUrl: 400 },
      { url: `https://${WWW}/blog/q3-product-update`, count: 2300, under5s: 1000, singleUrl: 1800 },
      { url: `https://${DOCS}/getting-started`, count: 2200, under5s: 700, singleUrl: 1200 },
      { url: 'http://localhost:3000/dashboard', count: 1900, under5s: 700, singleUrl: 600 },
      { url: `https://${DOCS}/api/reference`, count: 1700, under5s: 600, singleUrl: 1100 },
      { url: 'https://staging.tidebrook.example/dashboard', count: 1400, under5s: 500, singleUrl: 400 },
      { url: `https://${APP}/reports/8812`, count: 1100, under5s: 200, singleUrl: 150 },
      { url: 'https://tidebrook-git-feat-new-billing-tidebrook.vercel.app/settings/billing', count: 400, under5s: 100, singleUrl: 100 },
    ],
  },
  flags: {
    definitions: [
      flag('new-billing-page', { evaluationRuntime: 'server' }),
      flag('ai-summaries'),
      flag('onboarding-v3', { ensureExperienceContinuity: true }),
      flag('checkout-redesign', { ensureExperienceContinuity: true }),
      flag('beta-customers-only', { usesStaticCohort: true }),
      flag('dark-mode', { evaluationRuntime: 'client' }),
      flag('inbox-zero'),
      flag('report-scheduler', { evaluationRuntime: 'server' }),
      flag('pricing-page-test'),
      flag('search-v2'),
      flag('export-csv-v2', { evaluationRuntime: 'server' }),
      flag('slack-digest', { evaluationRuntime: 'server' }),
      flag('sso-enforcement', { usesIsNotSet: true, evaluationRuntime: 'server' }),
      flag('grid-virtualization', { evaluationRuntime: 'client' }),
      flag('api-rate-limit-v2', { evaluationRuntime: 'server' }),
      flag('legacy-reports-banner', { lastCalledAt: '2026-08-30T10:12:00.000Z' }),
      flag('holiday-promo-2025', { lastCalledAt: '2026-01-04T18:03:00.000Z' }),
      flag('mobile-nav-experiment', { lastCalledAt: null }),
    ],
    calledByLib: [...flagCalled.values()].sort(desc),
  },
  billing: {
    discountPercent: null,
    limitsUsd: {},
    pricing: null,
    projectedTotalUsd: null,
    currentTotalUsd: null,
    periodStart: null,
    periodEnd: null,
  },
  notes: [],
};

const out = fileURLToPath(new URL('../fixtures/demo-snapshot.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${out}: ${billable.toLocaleString('en-US')} billable events (${billableIdentified.toLocaleString('en-US')} identified) in 30 days.`);

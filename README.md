# frumo

**Find what's driving your PostHog bill and get ready-to-paste fixes, each with a dollar estimate.**
A free, open-source, read-only CLI that runs on your own machine. Built for PostHog, not affiliated.
Website and waitlist: [frumo.marianoventures.com](https://frumo.marianoventures.com)

> **Unofficial. Not affiliated with or endorsed by PostHog Inc. Works with PostHog Cloud (US/EU) and self-hosted PostHog.**
> "PostHog" is used only to describe compatibility. frumo is an independent project.

```text
$ npx frumo-cli demo

ESTIMATED MONTHLY BILL  whole organization
  Product analytics events                                  9.02M events        $291
  Person profiles (identified events add-on)     7.28M identified events        $566
  Session replay (web recordings)                       72.6K recordings        $218
  Feature flags & experiments                        11.3M flag requests        $493
  Surveys                                           880 survey responses          $0 free tier
  Error tracking                                          56K exceptions          $0 free tier
  Total                                                                       $1,568

POTENTIAL SAVING  $961/mo (−61%) with every fix  ·  $542/mo (−35%) with no-regret fixes only

TOP COST DRIVERS  share of this month's bill at your average rates; drivers overlap, so they don't add up
  #   Driver                                                                 Volume/mo     Cost/mo
  1   Feature flag requests                                                  9.87M req        $430
  2   Server-side flag checks without local evaluation                       8.45M req        $368
  3   $autocapture (autocaptured clicks, changes and submits)             3.18M events        $300
  4   Session recordings                                                     64.2K rec        $193
  5   Staging project "Tidebrook (staging)" shares your allowance         1.06M events        $137
  …

FIXES  ranked by estimated monthly saving if applied on its own

  1. Evaluate flags locally in posthog-node, posthog-python
     −$338/mo  no-regret  [flags-local-evaluation]
     Evidence  551K server-side flag checks/mo evaluated remotely.
     Assumes   The 8.45M requests/mo beyond ~1 per page load are server-side checks; local
               evaluation replaces them with background polling: 4 always-on server instances
               (--server-instances) × 86,400 polls/month … = 346K requests/mo.
     You lose  Nothing functional: flag changes reach servers within the polling interval …
     ── posthog-node ──
     export const posthog = new PostHog(process.env.POSTHOG_PROJECT_TOKEN, {
       host: 'https://us.i.posthog.com',
       secretKey: process.env.POSTHOG_FLAGS_SECRET_KEY, // project secret API key with feature_flag:read
       featureFlagsPollingInterval: 30000, // ms; raise it to poll less often
     })
  …
POSTHOG.INIT CHANGES  every posthog-js option above in one diff (review before shipping)
   posthog.init('<ph_project_token>', {
  +  autocapture: {
  +    // no autocapture on marketing/docs pages [autocapture-marketing-pages: $92/mo]
  +    url_ignorelist: [/^https?:\/\/(www\.tidebrook\.example|docs\.tidebrook\.example)\//],
  …
  +  // replaces 'always' if you set it (identified_only is the default) [person-profiles-identified-only: $79/mo]
  +  person_profiles: 'identified_only',
  …
```

The demo data is a **fictional** company ("Tidebrook", hosts under the reserved `.example` domain). No real PostHog account is contacted.

## Contents

- [Quick start](#quick-start)
- [What it looks at](#what-it-looks-at)
- [Live mode (your PostHog)](#live-mode-your-posthog)
- [Offline mode](#offline-mode)
- [How the estimates are calculated](#how-the-estimates-are-calculated)
- [Pricing source](#pricing-source)
- [Sentry (preview)](#sentry-preview)
- [Privacy and security](#privacy-and-security)
- [CLI reference](#cli-reference)
- [Development](#development)
- [Disclaimer and licence](#disclaimer-and-licence)
- [Working on this repo](#working-on-this-repo)

## Quick start

Node.js 18.18 or newer. No account needed for the demo:

```sh
npx frumo-cli demo                          # terminal summary
npx frumo-cli demo --html report.html       # self-contained HTML report
npx frumo-cli demo --json > report.json     # machine-readable
# or: npm i -g frumo-cli   then   frumo demo
```

`frumo-cli` is not on npm yet. From a clone:

```sh
npm install
npm run demo                 # builds, then runs the demo
node dist/cli.js demo --html report.html   # after npm run demo (or npm run build)
```

## What it looks at

| Area | What frumo measures | Fixes it can suggest |
|---|---|---|
| Product analytics | Top events by cost; `$autocapture` by page, DOM event and element; `$pageview`/`$pageleave`; `$web_vitals`/`$dead_click`; events PostHog doesn't bill | `autocapture.url_ignorelist` for marketing pages, `dom_event_allowlist`, `css_selector_ignorelist` for noisy elements, `capture_pageleave: false`, `capture_dead_clicks: false`, `capture_performance: { web_vitals: false }` |
| Person profiles | Identified vs anonymous events; identified events from visitors posthog-js reported as *not* identified (`$is_identified: false`), by page | `person_profiles: 'identified_only'`; no `group()`/`setPersonProperties()` for anonymous visitors |
| Identity calls | `$identify`, `$set`, `$groupidentify` compared with distinct (session, user, day, group) combinations | Identify once after login, `group()` once per session, no `identify()` per server request |
| Server SDKs | Identified events from posthog-node/python/… whose names look like backend bookkeeping | `process_person_profile: false` with a distinct ID that isn't a person |
| Bots | Events from crawler, monitoring and HTTP-library user agents (`$raw_user_agent`) | `custom_blocked_useragents`, a user-agent check before server-side `capture()` |
| Dev traffic | localhost, private IPs, tunnels, Vercel/Netlify/Cloudflare previews and staging hosts sending to production | `opt_out_capturing_by_default`, `disable_session_recording`, `advanced_disable_flags` behind an `isDevHost` check |
| Other projects | Usage of every project in the organization (they share the free allowance and tiers) | Trim staging projects; other projects are listed so you can audit them |
| Session replay | Recordings, share under 5 s, share starting on marketing pages (and single-page), current sampling/min-duration settings | Minimum duration (5 s), URL trigger for app pages, sampling, via replay trigger groups |
| Feature flags | `/flags` requests (billing API), requests per pageview, server-side `$feature_flag_called` with `locally_evaluated=false`, active/stale flags, flags that can't be evaluated locally | Local evaluation (with polling cost added back), a longer polling interval, `advanced_disable_feature_flags_on_first_load` on marketing pages, bootstrapping |
| Surveys, error tracking | Responses and exceptions with their cost | Cost lines only in v1 |
| Billing limits | Current limits (billing API) and expected spend after fixes | A suggested limit per product |

Every fix lists **evidence**, the **assumption** behind its dollar figure, what **you lose**, steps, docs links and, where it applies, code. All `posthog.init` changes are also merged into **one reviewable diff**. Option names come from PostHog's docs ([posthog-js config](https://posthog.com/docs/libraries/js/config), [autocapture](https://posthog.com/docs/product-analytics/autocapture), [feature flag costs](https://posthog.com/docs/feature-flags/cutting-costs), [replay controls](https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record)); a test fails if a fix uses an option outside that checked list.

## Live mode (your PostHog)

### 1. Create a read-only personal API key

In PostHog: **Settings → Personal API keys → Create key**. Give it only these scopes:

| Scope | Needed for | If missing |
|---|---|---|
| `query:read` | **Required.** 13 hard-coded HogQL `SELECT`s: event counts, autocapture, identity calls, bots, replay metadata | Nothing to analyze; frumo stops |
| `billing:read` | Organization usage per project (including `/flags` requests, which no query can see), your plan's tiers, discount and billing limits | Costs use public prices and this project only; flag requests are "not analyzed" |
| `project:read` | Replay and autocapture settings; project names | Settings-based checks are skipped |
| `feature_flag:read` | Active flags, stale flags, flags that can't be evaluated locally | Flag details are skipped |

No write scope is ever needed. `session_recording:read` and `event_definition:read` are not needed: replay metadata is read through HogQL (`session_replay_events`) and event names come from the queries. Scope the key to the one project if you like.

### 2. Put the key in an environment variable

The key is read **only** from the `FRUMO_API_KEY` environment variable. frumo refuses keys passed as command-line arguments (they end up in shell history and process lists). For compatibility, the old name `HOGPOST_API_KEY` still works when `FRUMO_API_KEY` is unset, but it is deprecated: rename it.

```sh
read -rs FRUMO_API_KEY && export FRUMO_API_KEY   # paste, press Enter (nothing is echoed)
```

### 3. Run it

```sh
npx frumo-cli --project 12345                                  # US Cloud (default host https://us.posthog.com)
npx frumo-cli --project 12345 --host https://eu.posthog.com    # EU Cloud
npx frumo-cli --project 12345 --host https://posthog.example.internal   # self-hosted
npx frumo-cli --project 12345 --html report.html --save-snapshot snapshot.json
```

`--project` is the numeric ID from **Project settings**. Pasting the ingestion host (`us.i.posthog.com`, `eu.i.posthog.com`) is fine: it is mapped to the API host.

### What it calls

| Request | Scope | Why |
|---|---|---|
| `GET /api/projects/:id/` | project:read | Replay sample rate, minimum duration, trigger groups, autocapture setting, name |
| `GET /api/billing/` | billing:read | Your plan's tiers, discount, current billing limits, PostHog's own projection |
| `GET /api/billing/usage/` | billing:read | Daily usage per project for the window (events, identified events, recordings, flag requests, survey responses, exceptions) |
| `GET /api/organizations/@current/projects/` | project:read | Project names for that breakdown |
| `GET /api/projects/:id/feature_flags/` | feature_flag:read | Active flags (paginated) |
| `POST /api/projects/:id/query/` | query:read | 13 HogQL `SELECT`s, listed by `frumo --print-queries` |

`POST /api/projects/:id/query/` is PostHog's query endpoint. It is a **read**: frumo only sends `HogQLQuery` bodies whose SQL is one of the hard-coded `SELECT`s in [`src/sources/live/queries.ts`](src/sources/live/queries.ts). No user input is ever put into SQL (the only parameter is the window length, validated as an integer from 1 to 90 days). The client refuses any other method, path, query kind or SQL before sending, and tests check this with a mocked `fetch`.

**Rate limits.** Requests are sequential (about 20 in total, with a short pause between them). A `429` is retried after the `Retry-After` header (up to 60 s), other failures back off exponentially (1, 2, 4, 8 s). Queries made with a personal API key count against PostHog's hourly query read budget; if a big project hits it, re-run later or read a shorter window with `--days 7` (results are scaled to 30 days). Any optional call that fails is skipped and listed under "Notes", so a partial audit still comes out.

**Dates.** HogQL queries cover the last N × 24 hours; billing usage covers the last N complete UTC days (it is reported daily). Both are normalized to a 30-day month.

## Offline mode

### Snapshots

`--save-snapshot snapshot.json` stores exactly what live mode collected (never the key). Re-run the audit any time, or on another machine, with:

```sh
npx frumo-cli --from snapshot.json --html report.html
npx frumo-cli demo --save-snapshot template.json   # a complete example to edit by hand
```

The format is `frumo.snapshot/v1`, defined and validated in [`src/snapshot.ts`](src/snapshot.ts). Snapshots saved before the rename (`hogpost.snapshot/v1`) are the same format and still load. Every section except `period` is optional; analyses without their data are listed as "not analyzed". All counts cover `period.days` days. An abbreviated example:

```jsonc
{
  "schema": "frumo.snapshot/v1",
  "generatedAt": "2026-11-18T09:00:00.000Z",
  "source": { "kind": "live", "host": "https://eu.posthog.com", "toolVersion": "0.1.0", "fictional": false, "label": null },
  "project": { "id": "12345", "name": "Production" },
  "period": { "days": 30, "start": "…", "end": "…" },
  // Billing usage per project (billing:read). The audited project has "audited": true.
  "orgUsage": [
    { "projectId": "12345", "name": "Production", "audited": true,
      "usage": { "events": 7959000, "identifiedEvents": 6640580, "recordings": 64200, "mobileRecordings": 0,
                 "flagRequests": 9870000, "surveyResponses": 880, "exceptions": 44000 } }
  ],
  "projectSettings": { "autocaptureOptOut": false, "sessionRecordingSampleRate": null, "sessionRecordingMinimumDurationMs": null, "…": "…" },
  "events": {
    "totals": { "all": 8700000, "billable": 7959000, "billableIdentified": 6640580, "unidentifiedPersonEvents": 1130000 },
    "byEvent": [{ "event": "$autocapture", "count": 2950000, "identified": 2380000 }],
    "byHost": [{ "host": "app.example.com", "count": 3500000, "identified": 3400000 }],
    "byPage": [{ "host": "www.example.com", "path": "/", "count": 1400000, "identified": 790000,
                 "unidentifiedPersonEvents": 735000, "pageviews": 262000, "pageleaves": 218000, "autocapture": 820000 }],
    "autocaptureDomEvents": [{ "domEvent": "change", "host": "app.example.com", "count": 300000 }],
    "autocaptureElements": [{ "host": "app.example.com", "domEvent": "click", "tag": "button", "classes": ".grid-cell", "text": "42", "count": 640000, "sessions": 52000 }],
    "identity": [{ "event": "$identify", "lib": "posthog-node", "count": 214000, "necessary": 31000 }],
    "bots": [{ "userAgent": "Mozilla/5.0 (compatible; AhrefsBot/7.0; …)", "lib": "posthog-node", "count": 38000, "identified": 38000 }],
    "serverEvents": [{ "lib": "posthog-node", "event": "api_request", "count": 720000, "identified": 720000 }]
  },
  "replay": {
    "recordings": 64200,
    "durations": { "under5s": 19900, "under10s": 26400, "under30s": 35800, "under60s": 41600 },
    "activeUnder5s": 27100,
    "byFirstUrl": [{ "url": "https://www.example.com/", "count": 18400, "under5s": 7600, "singleUrl": 11900 }]
  },
  "flags": {
    "definitions": [{ "key": "new-billing", "active": true, "ensureExperienceContinuity": false, "usesStaticCohort": false,
                      "usesIsNotSet": false, "evaluationRuntime": "server", "lastCalledAt": "2026-11-17T22:41:00Z" }],
    "calledByLib": [{ "lib": "posthog-node", "locallyEvaluated": "false", "count": 520000, "flags": 9 }]
  },
  "billing": { "discountPercent": null, "limitsUsd": { "product_analytics": 500 }, "pricing": null,
               "projectedTotalUsd": null, "currentTotalUsd": null, "periodStart": null, "periodEnd": null },
  "notes": []
}
```

### CSV of event counts

The simplest input: event names and counts, optionally with identified counts.

```csv
event,count,identified
$autocapture,3620000,2050000
$pageview,1240000,690000
api_request,610000,610000
```

Header optional; comma, semicolon or tab separated; quoted fields and thousands separators are fine. Counts are treated as covering `--days` days (default 30). You can export it from PostHog's SQL editor:

```sql
SELECT event, count() AS count, countIf(person_mode IN ('full', 'force_upgrade')) AS identified
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
GROUP BY event
ORDER BY count DESC
```

A CSV gives event-level drivers and costs only (and assumes this project is your whole organization). Everything that needs pages, user agents, replay or flag data is listed as "not analyzed".

## How the estimates are calculated

1. **Monthly volume.** Counts are scaled from the window to a 30-day month. When billing usage is available, breakdown shares from HogQL are applied to the billed totals, so the two stay consistent.
2. **Organization-wide usage.** PostHog bills usage and free allowances across all projects of an organization, so the bill is computed on the sum of every project's usage. Without `billing:read` (or a CSV), frumo assumes the audited project is the whole organization and says so.
3. **Graduated tiers.** Each product's monthly units go through its price tiers: the first tier is the free allowance, and each unit is charged at the rate of the tier it falls into ([`src/pricing/math.ts`](src/pricing/math.ts), unit-tested against PostHog's own worked examples, e.g. 10M anonymous events ≈ $324). **Identified events** pay the event rate plus the person-profile add-on rate (the "Person profiles" line on the invoice).
4. **Cost drivers** are a share of the bill: a slice's units × your *average effective rate* for that product (anonymous events at the event rate, identified ones at event + person-profile rate). Drivers overlap (bot traffic also contains autocapture) and are not additive.
5. **Savings per fix** = cost now − cost after the fix's volume change, re-priced through the tiers (so a fix that moves you into a cheaper tier, or into the free allowance, is valued correctly). Each fix states its volume assumption, for example "drops 100% of `$pageleave`" or "requests beyond ~1 per page load are server-side checks; local evaluation replaces them with 4 instances × 86,400 polls/month".
6. **Combined saving.** Fixes are applied one after another as fractions of what remains, so overlaps are counted once (assuming they overlap independently). The headline shows every fix, and **no-regret** fixes only (data you almost certainly don't use: bots, dev hosts, duplicate identify calls, person profiles for anonymous visitors, sub-5-second recordings, local evaluation). **Trade-off** fixes give something up, written under "You lose".
7. **Billing limits.** Suggested limit per product = expected spend after the no-regret fixes × 1.3, rounded up to a tidy number (with the pre-fix figure in case you set the limit before shipping fixes). PostHog stops ingesting a product's data for the rest of the period when its limit is reached, so the headroom matters.

### Limits of the estimates (please read)

- **Not your invoice.** Estimates use list prices (or your plan's tiers when `billing:read` returns them). Credits, annual or startup plans, rounding and billing-period timing are not modelled; use `--pricing` for contract prices.
- **Not estimated:** group analytics add-on, data pipelines/destinations, AI observability, logs, data warehouse rows and other products.
- **Heuristics:** marketing pages, dev hosts, staging projects, bot user agents and "system-like" server event names are recognized by patterns. The report lists how each host was classified; override with `--marketing-url`, `--app-url` and `--dev-host`.
- **Top-N data:** breakdown queries return the top rows (for example 500 pages, 100 elements). Shares are computed against the full totals, so missing tail rows make savings smaller, never larger.
- **Flag requests** are split into browser and server traffic with an estimate (about one request per page load, plus identify/group calls). Polling cost assumes `--server-instances` always-on instances (default 4) with an ETag-capable SDK.
- **`$is_identified`** comes from posthog-js only; mobile and server events are not counted as "never identified".
- **Replay "app-only" savings** count marketing-first recordings that never visited a second URL; sessions that later reach the app would still be recorded.
- **Self-hosted:** dollar figures show what the same volume would cost on PostHog Cloud. Your own infrastructure costs scale with the same volumes.

## Pricing source

All prices live in one file, [`src/pricing/public-pricing.ts`](src/pricing/public-pricing.ts), with its source and retrieval date. A test fails if a price appears anywhere else in the code.

- **Source:** <https://posthog.com/pricing> ("See all products and per-unit rates"), **retrieved 2026-11-18**, cross-checked with PostHog's product pricing docs and the [anonymous events pricing post](https://posthog.com/blog/analytics-pricing).

| Product | Free / month | Paid tiers (per unit, graduated) |
|---|---|---|
| Product analytics events | 1M | 1–2M $0.00005 · 2–15M $0.0000343 · 15–50M $0.0000295 · 50–100M $0.0000218 · 100–250M $0.000015 · 250M+ $0.000009 |
| Person profiles (identified events add-on) | 1M | 1–2M $0.000198 · 2–15M $0.0000697 · 15–50M $0.000036 · 50–100M $0.0000146 · 100–250M $0.0000037 · 250M+ $0.000001 |
| Session replay (web) | 5,000 | 5–15K $0.005 · 15–50K $0.0035 · 50–150K $0.002 · 150–500K $0.0017 · 500K+ $0.0015 |
| Session replay (mobile) | 2,500 | 2.5–15K $0.01 · 15–50K $0.007 · 50–150K $0.004 · 150–500K $0.0034 · 500K+ $0.003 |
| Feature flags & experiments (requests) | 1M | 1–2M $0.0001 · 2–10M $0.000045 · 10–50M $0.000025 · 50M+ $0.00001 |
| Surveys (responses) | 1,500 | 1,500–2,000 $0.10 · 2–10K $0.035 · 10–20K $0.015 · 20K+ $0.01 |
| Error tracking (exceptions) | 100K | 100–325K $0.00037 · 325K–10M $0.00014 · 10M+ $0.000115 |

If a price can't be verified, its tiers are `null`: frumo then shows volumes without a dollar figure for that product and says so in the report. In live mode with `billing:read`, tiers from your own plan (`GET /api/billing/`) replace the public ones where they parse cleanly; `--public-pricing` turns that off.

### Pricing overrides (custom contracts)

```sh
npx frumo-cli --project 12345 --pricing our-contract.json
```

```json
{
  "name": "Our 2026 contract",
  "source": "Order form #123",
  "retrieved": "2026-11-01",
  "discountPercent": 15,
  "products": {
    "product_analytics": { "tiers": [ { "upTo": 1000000, "unitUsd": 0 }, { "upTo": null, "unitUsd": 0.00002 } ] },
    "session_replay": { "tiers": null, "unverifiedReason": "Not on our contract" }
  }
}
```

Products you don't list keep public prices. Product keys: `product_analytics`, `identified_events`, `session_replay`, `mobile_replay`, `feature_flags`, `surveys`, `error_tracking`. Tiers in PostHog's API shape (`up_to`, `unit_amount_usd`) are accepted too. Invalid files are rejected with every problem listed.

## Sentry (preview)

`frumo sentry` audits a **Sentry** bill the same way: usage in, public prices, ranked fixes with paste-ready `Sentry.init` snippets. It is a small, read-only v1; PostHog stays frumo's main focus.

> Unofficial. Not affiliated with or endorsed by Functional Software, Inc. (Sentry). "Sentry" is used only to describe compatibility. Dollar figures are **estimates from public list prices, not your invoice**: the plan fee, reserved volume, mid-cycle plan changes, credits and Enterprise contracts all differ.

```sh
npx frumo-cli sentry demo                     # bundled fictional org, no account, no network
read -rs SENTRY_AUTH_TOKEN && export SENTRY_AUTH_TOKEN
npx frumo-cli sentry --org my-org             # live, read-only (Team prices)
npx frumo-cli sentry --org my-org --plan business --days 14 --json > sentry-report.json
```

**Token.** Create a personal auth token in Sentry (User settings > Personal Tokens) with only `org:read`, `project:read` and `event:read`. It is read only from `SENTRY_AUTH_TOKEN`, never accepted as an argument, sent only in the `Authorization` header to `https://sentry.io` (or the https `--host` you pass for self-hosted Sentry or another region, e.g. `https://de.sentry.io`), never logged or saved, and redirects are not followed.

**What it calls** (GET only; anything else is refused in code and in tests):

| Request | Scope | Why |
|---|---|---|
| `GET /api/0/organizations/:org/projects/` | org:read | Project slugs and platforms |
| `GET /api/0/organizations/:org/stats_v2/` (once per category: error, transaction, replay, attachment) | org:read | Volume by project and outcome (accepted, filtered, rate_limited, …) |
| `GET /api/0/organizations/:org/issues/?query=&sort=freq` (up to 2 pages of 100) | event:read | Noisiest issues in any status, including ignored/archived |
| `GET /api/0/projects/:org/:project/filters/` (5 busiest projects) | project:read | Which built-in inbound filters are on |
| `GET /api/0/projects/:org/:project/keys/` (5 busiest projects) | project:read | Whether each client key has a rate limit |

The client-keys endpoint also returns DSNs and the public/secret key. frumo keeps only the key label, whether it is active and its rate limit; it never prints, logs or saves a DSN or key, and refuses to build a snapshot that contains one.

**What it looks at.**

- **Ignored issues that still bill.** Ignoring (archiving) an issue hides it, but its events [still count toward your quota](https://docs.sentry.io/pricing/quotas/). frumo lists them with a dollar estimate and an `ignoreErrors` / `beforeSend` snippet to drop them in the SDK (no-regret).
- **Noisy unresolved issues.** Any unresolved issue sending at least 5% of accepted errors: fix it, or drop known noise client-side (trade-off).
- **Built-in inbound filters left off** in the busiest projects: browser extensions, web crawlers, localhost, health-check transactions. These are available on every plan. Custom inbound filters (by error message, release or IP) and Delete & Discard need Business or Enterprise (custom filters also on Trial), so frumo does not suggest them on `--plan team`. See [filtering](https://docs.sentry.io/concepts/data-management/filtering/) and [managing your event stream](https://docs.sentry.io/pricing/quotas/manage-event-stream-guide/).
- **High-volume projects:** accepted volume and share of the estimated bill by project and category.
- **Rate limits and spike protection.** Keys without a rate limit are flagged; per-key (DSN) rate limits are Business/Enterprise only. [Spike protection](https://docs.sentry.io/pricing/quotas/spike-protection/) covers errors, spans/transactions and attachments, not replays; it is set in Settings > Spike Protection and frumo never changes it.
- **Sampling** (`tracesSampleRate`, and `sampleRate` for errors as a last resort) only when that volume costs enough to matter. Sampling hides events and needs a redeploy.

**How the estimate works.** Accepted volume per category, scaled to a 30-day month, minus the plan's included volume (50K errors, 5M spans, 50 replays, 1 GB attachments on Team and Business), through Sentry's graduated pay-as-you-go bands. A fix's saving is the bill today minus the bill with that volume removed, at the same bands. Tracing volume is read from the `transaction` stats category and priced as one span per transaction, so the spans line is a lower bound when your organization is billed on spans. Attachments are reported in bytes and priced per decimal GB. Logs, metrics, profiling, Seer, cron and uptime monitors are not estimated.

**Sentry prices**, checked 2026-11-20 from <https://docs.sentry.io/pricing/> and <https://sentry.io/pricing/> (per unit, above the included volume):

| Category | Band | Team | Business |
|---|---|---|---|
| Errors | 50K–100K | $0.0003625 | $0.0011125 |
| Errors | 100K–500K | $0.0002188 | $0.000625 |
| Errors | 500K–10M | $0.0001875 | $0.000375 |
| Errors | 10M–20M | $0.0001625 | $0.000325 |
| Errors | over 20M | $0.00015 | $0.0003 |
| Spans | 5M–100M | $0.000002 | $0.000004 |
| Spans | over 100M | $0.0000018 | $0.0000036 |
| Replays | 50–5K | $0.00375 | $0.00375 |
| Replays | 5K–100K | $0.003563 | $0.003563 |
| Replays | 100K–900K | $0.003206 | $0.003206 |
| Replays | 900K–4.5M | $0.002886 | $0.002886 |
| Replays | over 4.5M | $0.002453 | $0.002453 |
| Attachments | over 1 GB | $0.3125 per GB | $0.3125 per GB |

The table lives in `SENTRY_PUBLIC_PRICING` in [`src/pricing/public-pricing.ts`](src/pricing/public-pricing.ts). `--json` prints the `frumo.sentry-report/v1` shape in [`src/sentry/model.ts`](src/sentry/model.ts); `--save-snapshot` writes a `frumo.sentry-snapshot/v1` file you can re-run with `frumo sentry --from`. There is no HTML report for Sentry yet.

The demo is a **fictional** organization ("Tidebrook" again, with invented projects, issues and counts). No real Sentry account or event data is used.

## Privacy and security

- **Runs locally.** The only network peer is the PostHog host you choose (live mode), or the Sentry host for `frumo sentry --org`. Demo and offline modes (including `frumo sentry demo`) make no network requests. There is no telemetry, no analytics and no update check.
- **The waitlist line.** The terminal summary and the HTML report end with one plain-text line, "Found this useful? Join the frumo waitlist", and a link (`?ref=cli` or `?ref=report`). frumo never requests that URL, opens a browser or loads anything for it; nothing is sent unless you click the link yourself. `--no-footer` leaves it out, and `--json` never includes it.
- **Read-only.** Only `GET`s and the hard-coded HogQL `SELECT`s above. Write methods are refused in code and in tests.
- **Your key** is read only from `FRUMO_API_KEY` (or the deprecated `HOGPOST_API_KEY` when that is unset), kept in a wrapper that prints as `[REDACTED]`, sent only in the `Authorization` header over HTTPS (plain HTTP only for localhost or with `--allow-http`), never logged, never written to disk, and redacted from every error message. Redirects are not followed, so the key can't be forwarded to another host.
- **Snapshots and reports** contain aggregated counts, hostnames, URL paths, user-agent strings, element classes/texts and flag keys, but no person data or credentials. Review them before sharing.
- **The HTML report** is one file with inline CSS and a few lines of inline JavaScript (copy buttons). Its Content-Security-Policy (`default-src 'none'`) blocks any network request.

## CLI reference

```text
Usage
  frumo demo                              Run on bundled fictional data (no account needed)
  frumo --project <id> [--host <url>]     Live, read-only audit (key in FRUMO_API_KEY)
  frumo --from <snapshot.json|counts.csv> Offline audit from a saved snapshot or event-count CSV
  frumo --print-queries                   Show every HogQL query frumo can run, then exit
  frumo sentry demo                       Sentry bill audit on bundled fictional data (preview)
  frumo sentry --org <slug>               Live, read-only Sentry audit; see "frumo sentry --help"

Live mode
  FRUMO_API_KEY              Personal API key (env var only; never pass it as an argument)
  HOGPOST_API_KEY            Deprecated old name, still read when FRUMO_API_KEY is unset
  --project <id>             Numeric project ID (Project settings → Project ID)
  --host <url>               https://us.posthog.com (default), https://eu.posthog.com, or your self-hosted URL
  --days <n>                 Window to read, 1-90 days (default 30); results are scaled to 30 days
  --save-snapshot <file>     Also save the collected data (never contains your key) for offline runs
  --allow-http               Allow a plain-http self-hosted host (not recommended)
  Scopes: query:read (required); billing:read, project:read, feature_flag:read (recommended)

Output
  --html <file>              Write a self-contained HTML report
  --json                     Print the full report as JSON to stdout (progress goes to stderr)
  --full                     Print every code snippet in the terminal summary
  --no-color / --color       Force colors off/on (NO_COLOR is respected)
  -q, --quiet                No progress output
  --verbose                  Log each API request (method, path, status; never headers)
  --no-footer                Leave out the waitlist link at the end of the summary and HTML report

Estimates
  --pricing <file>           Your own prices (custom contract), JSON; see README "Pricing overrides"
  --public-pricing           Ignore tiers from your billing plan and use PostHog's public list prices
  --server-instances <n>     Always-on server instances, for local-evaluation polling estimates (default 4)
  --marketing-url <regex>    URLs to treat as marketing/content pages (repeatable)
  --app-url <regex>          URLs to treat as app pages (repeatable; wins over marketing)
  --dev-host <regex>         Hosts to treat as local/preview/staging (repeatable)
  --days <n>                 For CSV input: days the counts cover (default 30)

Sentry (preview)
  SENTRY_AUTH_TOKEN          Sentry personal auth token for frumo sentry (env var only)
  Scopes: org:read, project:read, event:read (nothing wider)
  --plan team|business       Sentry price list to estimate with (default team)

  -h, --help                 Show this help
  -v, --version              Show the version
```

Exit codes: `0` success, `1` failure (API, file or validation error), `2` usage error. `--json` output follows the `frumo.report/v1` shape in [`src/analysis/model.ts`](src/analysis/model.ts).

## Development

```sh
npm ci               # exact versions from package-lock.json
npm run lint         # ESLint 9 flat config + typescript-eslint (type-aware)
npm run typecheck    # tsc --noEmit (no build needed)
npm test             # vitest; no network (the PostHog API is a mocked fetch); no build needed
npm run build        # TypeScript → dist/
npm run demo         # build + run the demo
npm run check        # lint + typecheck + test + build
node scripts/make-demo-fixture.mjs   # regenerate fixtures/demo-snapshot.json
```

TypeScript is pinned to 6.0.x because typescript-eslint supports TypeScript below 6.1. Zero runtime dependencies (Node's built-in `fetch` and `util.parseArgs`). Code map:

- `src/pricing/`: the price list (one file), graduated-tier math, `--pricing` overrides
- `src/snapshot.ts`: the snapshot format and its validator
- `src/sources/`: demo fixture, `--from` files (JSON/CSV), and live mode (`live/client.ts` read-only client, `live/queries.ts` hard-coded HogQL, `live/collect.ts`)
- `src/analysis/`: one analyzer per area in `analyzers/`, the cost model, fix ranking, snippets and the combined diff
- `src/report/`: terminal, HTML and JSON output
- `src/sentry/`: `frumo sentry` (snapshot format, GET-only client, collection, analysis, snippets, terminal report); its prices are in `src/pricing/public-pricing.ts`
- `test/`: unit tests per module, a fake PostHog API, and repository rules (one price source, Node 18-safe APIs, documented env vars only, CI scripts runnable without a build)

## Disclaimer and licence

frumo is unofficial and not affiliated with, endorsed by or sponsored by PostHog Inc. PostHog is a trademark of PostHog Inc. and is used here only to describe compatibility. Estimates are provided as-is and can differ from your invoice; review every change before shipping it.

[MIT](LICENSE) © 2026 Mariano Ventures

## Working on this repo

Read [AGENTS.md](AGENTS.md) before making changes. Pull requests must pass the CI checks: `lint`, `typecheck` and `test`.

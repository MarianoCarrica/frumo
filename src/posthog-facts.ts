/**
 * Facts about how PostHog counts and bills usage, with where each one comes from.
 * Keep this the single place for such rules so analyzers stay consistent.
 */

/**
 * Events PostHog does not bill as product analytics events.
 * Source: PostHog's usage report (posthog/tasks/usage_report.py, BILLABLE_EVENT_EXCLUDED_EVENTS);
 * `$ai_*` events are billed under AI observability instead. Survey responses and exceptions have
 * their own products (surveys, error tracking).
 */
export const NON_BILLABLE_EVENTS: readonly string[] = [
  '$feature_flag_called',
  '$experiment_exposure',
  'survey sent',
  'survey shown',
  'survey dismissed',
  '$exception',
  '$llm_prompt_fetched',
  '$conversations_loaded',
  '$conversations_widget_loaded',
  '$conversations_message_sent',
  '$conversations_user_identified',
  '$conversations_restore_link_requested',
  '$conversations_widget_state_changed',
  '$conversations_back_to_tickets',
  '$anomaly_score',
  '$anomaly_score_shadow',
  '$recording_observed',
];

export const NON_BILLABLE_EVENT_PREFIX = '$ai_';

export function isBillableEvent(event: string): boolean {
  return !NON_BILLABLE_EVENTS.includes(event) && !event.startsWith(NON_BILLABLE_EVENT_PREFIX);
}

/** Event that counts as a survey response (billed under Surveys). */
export const SURVEY_RESPONSE_EVENT = 'survey sent';
/** Event billed under Error tracking. */
export const EXCEPTION_EVENT = '$exception';

/** `$lib` values sent by PostHog's server-side SDKs. */
export const SERVER_LIBS: readonly string[] = [
  'posthog-node',
  'posthog-python',
  'posthog-ruby',
  'posthog-go',
  'posthog-php',
  'posthog-java',
  'posthog-server',
  'posthog-dotnet',
  'posthog-rs',
  'posthog-elixir',
];

export function isServerLib(lib: string | null | undefined): boolean {
  return typeof lib === 'string' && SERVER_LIBS.includes(lib);
}

/** `$lib` sent by posthog-js in the browser. */
export const WEB_LIB = 'web';

/**
 * Lower-case RE2/JS-compatible pattern for bot, crawler, monitoring and non-browser user agents.
 * Used verbatim in the hard-coded HogQL query and by the analyzers. Deliberately avoids
 * backslashes so it is identical in SQL and JavaScript.
 * posthog-js already drops many of these by default (case-insensitive substring match against its
 * built-in list); what shows up in your data is usually server-side capture, old SDKs, or agents
 * not on that list (synthetic monitoring, HTTP libraries).
 */
export const BOT_UA_PATTERN =
  '[a-z0-9]bot[/;)-]|(^|[ (;,])bot[/;)-]|bot$|crawl|spider|slurp|headless|lighthouse|pagespeed|gtmetrix|prerender|' +
  'python-requests|python-urllib|aiohttp|httpx/|curl/|wget/|go-http-client|okhttp|java/|libwww|axios/|node-fetch|' +
  'undici|scrapy|phantomjs|selenium|playwright|puppeteer|cypress|checkly|pingdom|uptimerobot|statuscake|site24x7|' +
  'datadogsynthetics|newrelicpinger|lightpanda|bytespider|facebookexternal';

const BOT_RE = new RegExp(BOT_UA_PATTERN);

export function isBotUserAgent(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_RE.test(ua) && !ua.includes('cubot');
}

/** Distinctive, readable token from a bot user agent (e.g. "AhrefsBot", "Checkly"), for blocklists. */
export function botToken(userAgent: string): string {
  const named = /(?:[A-Za-z][A-Za-z0-9_.-]*(?:bot|crawler|spider)\b)|checkly|python-requests|python-urllib|aiohttp|httpx|curl|wget|go-http-client|okhttp|axios|node-fetch|scrapy|phantomjs|selenium|playwright|puppeteer|cypress|pingdom|uptimerobot|statuscake|site24x7|DatadogSynthetics|NewRelicPinger|HeadlessChrome|Chrome-Lighthouse|Lighthouse|PageSpeed|GTmetrix|Prerender/i.exec(
    userAgent,
  );
  return named ? named[0] : userAgent;
}

/** Docs pages HogPost links to (all checked 2026-11-18). */
export const DOCS = {
  jsConfig: 'https://posthog.com/docs/libraries/js/config',
  autocapture: 'https://posthog.com/docs/product-analytics/autocapture',
  analyticsCuttingCosts: 'https://posthog.com/docs/product-analytics/cutting-costs',
  anonymousVsIdentified: 'https://posthog.com/docs/data/anonymous-vs-identified-events',
  identify: 'https://posthog.com/docs/product-analytics/identify',
  groupAnalytics: 'https://posthog.com/docs/product-analytics/group-analytics',
  localEvaluation: 'https://posthog.com/docs/feature-flags/local-evaluation',
  flagsCuttingCosts: 'https://posthog.com/docs/feature-flags/cutting-costs',
  bootstrapping: 'https://posthog.com/docs/feature-flags/bootstrapping',
  replayControls: 'https://posthog.com/docs/session-replay/how-to-control-which-sessions-you-record',
  billingLimits: 'https://posthog.com/docs/billing/limits-alerts',
  blockingBots: 'https://posthog.com/docs/libraries/js/usage#blocking-bad-actors',
  beforeSend: 'https://posthog.com/docs/libraries/js/usage#amending-or-sampling-events',
  estimatingUsage: 'https://posthog.com/docs/billing/estimating-usage-costs',
  pricing: 'https://posthog.com/pricing',
  heatmaps: 'https://posthog.com/docs/toolbar/heatmaps',
} as const;

/** Local-evaluation polling: one poll per 30s per server instance by default (PostHog docs). */
export const LOCAL_EVAL_POLLS_PER_INSTANCE_PER_MONTH = 2 * 60 * 24 * 30; // 86,400

/** Days a "month" means when HogPost normalizes counts. */
export const DAYS_PER_MONTH = 30;

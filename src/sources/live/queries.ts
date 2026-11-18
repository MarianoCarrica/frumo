/**
 * Every HogQL query HogPost can run, hard-coded. Nothing from user input is ever put into SQL:
 * the only parameter is the window length, validated as an integer between 1 and MAX_DAYS.
 * All queries are SELECTs that aggregate counts; none of them return personal data.
 * `hogpost --print-queries` prints them so you can review or run them yourself.
 */
import { BOT_UA_PATTERN, NON_BILLABLE_EVENTS, NON_BILLABLE_EVENT_PREFIX, SERVER_LIBS } from '../../posthog-facts.js';
import { UsageError } from '../../util/errors.js';

export const MAX_DAYS = 90;

export const QUERY_IDS = [
  'totals',
  'events_by_name',
  'by_lib',
  'by_host',
  'by_page',
  'autocapture_dom_events',
  'autocapture_elements',
  'identity',
  'bots',
  'server_events',
  'flags_called',
  'replay_summary',
  'replay_first_urls',
] as const;
export type QueryId = (typeof QUERY_IDS)[number];

export interface HogQLQuery {
  readonly id: QueryId;
  /** Sent as the query `name` so it is easy to find in your query log. */
  readonly name: string;
  readonly purpose: string;
  readonly sql: string;
}

/** Registry of query objects built by this module; the client refuses anything else. */
const issued = new WeakSet<object>();

export function isIssuedQuery(query: unknown): query is HogQLQuery {
  return typeof query === 'object' && query !== null && issued.has(query);
}

/** Quotes a compile-time constant. Throws on anything unexpected rather than escaping. */
function constant(value: string): string {
  if (!/^[\w$ .:-]*$/.test(value)) throw new Error(`Unexpected character in SQL constant: ${value}`);
  return `'${value}'`;
}

/** A single read-only statement: starts with SELECT, no statement separator outside string literals, no DDL/DML keywords. */
export function isSingleSelect(sql: string): boolean {
  const code = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  if (!/^\s*SELECT\b/i.test(code) || code.includes(';')) return false;
  return !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH|GRANT|REVOKE|OPTIMIZE|SYSTEM|KILL)\b/i.test(code);
}

export function validateDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new UsageError(`--days must be a whole number between 1 and ${MAX_DAYS}.`);
  }
  return days;
}

export function buildQueries(daysInput: number): HogQLQuery[] {
  const days = validateDays(daysInput);
  const window = `timestamp >= now() - INTERVAL ${days} DAY AND timestamp < now()`;
  const replayWindow = `start_time >= now() - INTERVAL ${days} DAY AND start_time < now()`;
  const billable = `event NOT IN (${NON_BILLABLE_EVENTS.map(constant).join(', ')}) AND NOT startsWith(event, ${constant(NON_BILLABLE_EVENT_PREFIX)})`;
  const identified = `person_mode IN ('full', 'force_upgrade')`;
  const unidentified = `${identified} AND toString(properties.$is_identified) IN ('false', '0')`;
  if (BOT_UA_PATTERN.includes("'") || BOT_UA_PATTERN.includes('\\')) throw new Error('BOT_UA_PATTERN must not contain quotes or backslashes');
  const ua = `lower(ifNull(properties.$raw_user_agent, ''))`;

  const definitions: Array<[QueryId, string, string]> = [
    [
      'totals',
      'Billable events, identified events and identified events from visitors who never identified',
      `
SELECT
  count() AS all_events,
  countIf(${billable}) AS billable,
  countIf(${billable} AND ${identified}) AS billable_identified,
  countIf(${billable} AND ${unidentified}) AS unidentified_person_events
FROM events
WHERE ${window}`,
    ],
    [
      'events_by_name',
      'Event volume by event name, with the identified share',
      `
SELECT event, count() AS total, countIf(${identified}) AS identified
FROM events
WHERE ${window}
GROUP BY event
ORDER BY total DESC
LIMIT 200`,
    ],
    [
      'by_lib',
      'Billable events by SDK ($lib)',
      `
SELECT properties.$lib AS lib, count() AS total, countIf(${identified}) AS identified
FROM events
WHERE ${window} AND ${billable}
GROUP BY lib
ORDER BY total DESC
LIMIT 50`,
    ],
    [
      'by_host',
      'Billable events by host (finds localhost, preview and staging hosts)',
      `
SELECT properties.$host AS host, count() AS total, countIf(${identified}) AS identified
FROM events
WHERE ${window} AND ${billable} AND properties.$host IS NOT NULL
GROUP BY host
ORDER BY total DESC
LIMIT 200`,
    ],
    [
      'by_page',
      'Billable events by page: pageviews, pageleaves, autocapture and identified events',
      `
SELECT
  properties.$host AS host,
  properties.$pathname AS path,
  count() AS total,
  countIf(${identified}) AS identified,
  countIf(${unidentified}) AS unidentified_person_events,
  countIf(event = '$pageview') AS pageviews,
  countIf(event = '$pageleave') AS pageleaves,
  countIf(event = '$autocapture') AS autocapture
FROM events
WHERE ${window} AND ${billable} AND properties.$host IS NOT NULL
GROUP BY host, path
ORDER BY total DESC
LIMIT 500`,
    ],
    [
      'autocapture_dom_events',
      'Autocaptured events by DOM event type (click/change/submit) and host',
      `
SELECT properties.$event_type AS dom_event, properties.$host AS host, count() AS total
FROM events
WHERE ${window} AND event = '$autocapture'
GROUP BY dom_event, host
ORDER BY total DESC
LIMIT 200`,
    ],
    [
      'autocapture_elements',
      'Most autocaptured elements (tag and classes, with a sample text) and clicks per session',
      `
SELECT
  properties.$host AS host,
  properties.$event_type AS dom_event,
  extract(elements_chain, '^([-a-zA-Z0-9_]+)') AS tag,
  extract(elements_chain, '^[-a-zA-Z0-9_]*((?:[.][-a-zA-Z0-9_]+)*)') AS classes,
  any(extract(splitByChar(';', elements_chain)[1], 'text="([^"]{0,80})')) AS text,
  count() AS total,
  uniq($session_id) AS sessions
FROM events
WHERE ${window} AND event = '$autocapture'
GROUP BY host, dom_event, tag, classes
ORDER BY total DESC
LIMIT 100`,
    ],
    [
      'identity',
      'identify/$set/group calls vs. distinct (session, user, day, group) combinations',
      `
SELECT
  event,
  properties.$lib AS lib,
  count() AS total,
  uniq(concat(ifNull(toString($session_id), ''), ':', distinct_id, ':', toString(toDate(timestamp)), ':', ifNull(toString(properties.$group_type), ''), ':', ifNull(toString(properties.$group_key), ''))) AS necessary
FROM events
WHERE ${window} AND event IN ('$identify', '$set', '$groupidentify', '$create_alias')
GROUP BY event, lib
ORDER BY total DESC
LIMIT 50`,
    ],
    [
      'bots',
      'Billable events from bot, crawler, monitoring and non-browser user agents',
      `
SELECT properties.$raw_user_agent AS user_agent, properties.$lib AS lib, count() AS total, countIf(${identified}) AS identified
FROM events
WHERE ${window} AND ${billable}
  AND (
    (match(${ua}, '${BOT_UA_PATTERN}') AND position(${ua}, 'cubot') = 0)
    OR properties.$browser_type = 'bot'
  )
GROUP BY user_agent, lib
ORDER BY total DESC
LIMIT 50`,
    ],
    [
      'server_events',
      'Events sent by server-side SDKs, with the identified share',
      `
SELECT properties.$lib AS lib, event, count() AS total, countIf(${identified}) AS identified
FROM events
WHERE ${window} AND ${billable} AND properties.$lib IN (${SERVER_LIBS.map(constant).join(', ')})
GROUP BY lib, event
ORDER BY total DESC
LIMIT 100`,
    ],
    [
      'flags_called',
      '$feature_flag_called by SDK and locally_evaluated (evidence of server-side remote evaluation)',
      `
SELECT
  properties.$lib AS lib,
  toString(properties.locally_evaluated) AS locally_evaluated,
  count() AS total,
  uniq(properties.$feature_flag) AS flags
FROM events
WHERE ${window} AND event = '$feature_flag_called'
GROUP BY lib, locally_evaluated
ORDER BY total DESC
LIMIT 50`,
    ],
    [
      'replay_summary',
      'Recording count and how many are very short',
      `
SELECT
  count() AS recordings,
  countIf(duration_s < 5) AS under_5s,
  countIf(duration_s < 10) AS under_10s,
  countIf(duration_s < 30) AS under_30s,
  countIf(duration_s < 60) AS under_60s,
  countIf(active_ms < 5000) AS active_under_5s
FROM (
  SELECT
    session_id,
    dateDiff('second', start_time, end_time) AS duration_s,
    active_milliseconds AS active_ms
  FROM session_replay_events
  WHERE ${replayWindow}
)`,
    ],
    [
      'replay_first_urls',
      'Where recordings start (first URL without query string), with short and single-page counts',
      `
SELECT url, count() AS total, countIf(duration_s < 5) AS under_5s, countIf(url_count <= 1) AS single_url
FROM (
  SELECT
    session_id,
    splitByChar('?', ifNull(first_url, ''))[1] AS url,
    dateDiff('second', start_time, end_time) AS duration_s,
    length(all_urls) AS url_count
  FROM session_replay_events
  WHERE ${replayWindow}
)
GROUP BY url
ORDER BY total DESC
LIMIT 300`,
    ],
  ];

  return definitions.map(([id, purpose, sql]) => {
    const query: HogQLQuery = Object.freeze({ id, name: `hogpost_${id}`, purpose, sql: sql.trim() });
    if (!isSingleSelect(query.sql)) throw new Error(`Query ${id} must be a single SELECT`);
    issued.add(query);
    return query;
  });
}

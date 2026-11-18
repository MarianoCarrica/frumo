import { parseArgs } from 'node:util';
import { DEFAULT_HOST } from './sources/live/hosts.js';
import { MAX_DAYS } from './sources/live/queries.js';
import { UsageError } from './util/errors.js';
import { looksLikeCredential } from './util/secret.js';

export type Mode = 'demo' | 'file' | 'live' | 'print-queries' | 'help' | 'version';

export interface CliArgs {
  mode: Mode;
  from: string | null;
  projectId: string | null;
  host: string;
  days: number;
  saveSnapshot: string | null;
  html: string | null;
  json: boolean;
  pricing: string | null;
  marketingUrl: RegExp[];
  appUrl: RegExp[];
  devHost: RegExp[];
  serverInstances: number;
  /** null = decide from the terminal and NO_COLOR/FORCE_COLOR. */
  color: boolean | null;
  quiet: boolean;
  verbose: boolean;
  full: boolean;
  allowHttp: boolean;
  planPricing: boolean;
}

export const API_KEY_ENV = 'HOGPOST_API_KEY';

const KEY_FLAG = /^--?(api[-_]?key|personal[-_]?api[-_]?key|key|token|secret|apikey|auth)(=.*)?$/i;

const KEY_ADVICE = `Don't pass API keys as command-line arguments: they end up in your shell history and process list. Put the key in the ${API_KEY_ENV} environment variable instead, e.g.\n  read -rs ${API_KEY_ENV} && export ${API_KEY_ENV}`;

export const HELP = `HogPost: find what drives your PostHog bill and get ready-to-paste fixes with $ estimates.
Unofficial; not affiliated with or endorsed by PostHog Inc. Read-only; runs on your machine.

Usage
  hogpost demo                              Run on bundled fictional data (no account needed)
  hogpost --project <id> [--host <url>]     Live, read-only audit (key in ${API_KEY_ENV})
  hogpost --from <snapshot.json|counts.csv> Offline audit from a saved snapshot or event-count CSV
  hogpost --print-queries                   Show every HogQL query HogPost can run, then exit

Live mode
  ${API_KEY_ENV.padEnd(27)}Personal API key (env var only; never pass it as an argument)
  --project <id>             Numeric project ID (Project settings → Project ID)
  --host <url>               ${DEFAULT_HOST} (default), https://eu.posthog.com, or your self-hosted URL
  --days <n>                 Window to read, 1-${MAX_DAYS} days (default 30); results are scaled to 30 days
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

Estimates
  --pricing <file>           Your own prices (custom contract), JSON; see README "Pricing overrides"
  --public-pricing           Ignore tiers from your billing plan and use PostHog's public list prices
  --server-instances <n>     Always-on server instances, for local-evaluation polling estimates (default 4)
  --marketing-url <regex>    URLs to treat as marketing/content pages (repeatable)
  --app-url <regex>          URLs to treat as app pages (repeatable; wins over marketing)
  --dev-host <regex>         Hosts to treat as local/preview/staging (repeatable)
  --days <n>                 For CSV input: days the counts cover (default 30)

  -h, --help                 Show this help
  -v, --version              Show the version

Examples
  npx hogpost demo --html demo-report.html
  ${API_KEY_ENV}=… npx hogpost --project 12345 --host https://eu.posthog.com --html report.html
  npx hogpost --from snapshot.json --json > report.json
`;

function compile(patterns: string[] | undefined, flag: string): RegExp[] {
  return (patterns ?? []).map((p) => {
    if (p.length > 500) throw new UsageError(`${flag} pattern is too long.`);
    try {
      return new RegExp(p, 'i');
    } catch (error) {
      throw new UsageError(`${flag} "${p}" is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function int(value: string | undefined, flag: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value.trim())) throw new UsageError(`${flag} must be a whole number.`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`${flag} must be between ${min} and ${max}.`);
  return n;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  for (const arg of argv) {
    if (KEY_FLAG.test(arg) || looksLikeCredential(arg)) throw new UsageError(KEY_ADVICE);
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message.replace(/\. To specify a positional argument.*$/s, '.')}\nRun "hogpost --help" for the options.`);
  }
  const { values, positionals } = parsed;

  if (positionals.length > 1) throw new UsageError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
  const command = positionals[0];
  if (command !== undefined && !['demo', 'audit', 'queries', 'help'].includes(command)) {
    throw new UsageError(`Unknown command "${command}". Commands: demo, audit (default), queries, help.`);
  }

  let mode: Mode;
  if (values.help || command === 'help') mode = 'help';
  else if (values.version) mode = 'version';
  else if (values['print-queries'] || command === 'queries') mode = 'print-queries';
  else if (values.demo || command === 'demo') mode = 'demo';
  else if (values.from !== undefined) mode = 'file';
  else if (values.project !== undefined) mode = 'live';
  else throw new UsageError('Nothing to audit. Use "hogpost demo", "--project <id>" (live) or "--from <file>".\nRun "hogpost --help" for details.');

  const sources = [mode === 'demo', values.from !== undefined, values.project !== undefined].filter(Boolean).length;
  if (mode !== 'help' && mode !== 'version' && mode !== 'print-queries' && sources > 1) {
    throw new UsageError('Choose one input: demo, --from <file>, or --project <id>.');
  }

  const projectId = values.project?.trim() ?? null;
  if (projectId !== null && !/^\d+$/.test(projectId)) {
    throw new UsageError('--project must be the numeric project ID (find it in Project settings → Project ID).');
  }
  const daysMax = mode === 'file' ? 366 : MAX_DAYS;
  const days = int(values.days, '--days', 1, daysMax) ?? 30;

  if (values.color && values['no-color']) throw new UsageError('Use either --color or --no-color.');
  const html = values.html ?? null;
  if (html !== null && html.trim() === '') throw new UsageError('--html needs a file name.');

  return {
    mode,
    from: values.from ?? null,
    projectId,
    host: values.host ?? DEFAULT_HOST,
    days,
    saveSnapshot: values['save-snapshot'] ?? null,
    html,
    json: values.json === true,
    pricing: values.pricing ?? null,
    marketingUrl: compile(values['marketing-url'], '--marketing-url'),
    appUrl: compile(values['app-url'], '--app-url'),
    devHost: compile(values['dev-host'], '--dev-host'),
    serverInstances: int(values['server-instances'], '--server-instances', 1, 10_000) ?? 4,
    color: values['no-color'] ? false : values.color ? true : null,
    quiet: values.quiet === true,
    verbose: values.verbose === true,
    full: values.full === true,
    allowHttp: values['allow-http'] === true,
    planPricing: values['public-pricing'] !== true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      demo: { type: 'boolean' },
      from: { type: 'string' },
      project: { type: 'string' },
      host: { type: 'string' },
      days: { type: 'string' },
      'save-snapshot': { type: 'string' },
      html: { type: 'string' },
      json: { type: 'boolean' },
      pricing: { type: 'string' },
      'public-pricing': { type: 'boolean' },
      'marketing-url': { type: 'string', multiple: true },
      'app-url': { type: 'string', multiple: true },
      'dev-host': { type: 'string', multiple: true },
      'server-instances': { type: 'string' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean' },
      full: { type: 'boolean' },
      'allow-http': { type: 'boolean' },
      'print-queries': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

/**
 * `frumo sentry …`: the Sentry bill audit. Routed here from src/cli.ts when the first argument
 * is "sentry". Unofficial; not affiliated with Functional Software, Inc. (Sentry).
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import { SENTRY_PLANS } from '../pricing/types.js';
import type { SentryPlan } from '../pricing/types.js';
import { MAX_DAYS } from '../sources/live/queries.js';
import { ApiError, UsageError } from '../util/errors.js';
import { Secret, looksLikeCredential, redact } from '../util/secret.js';
import { ValidationError } from '../util/validate.js';
import { VERSION } from '../version.js';
import { runSentryAnalysis } from './analysis.js';
import { SENTRY_SCOPES, SENTRY_TOKEN_ENV, readSentryToken } from './auth-token.js';
import { DEFAULT_SENTRY_HOST, SentryReadOnlyClient, normalizeSentryHost } from './client.js';
import { collectSentrySnapshot } from './collect.js';
import { renderSentryJson, renderSentryTerminal } from './report.js';
import { isSlug, parseSentrySnapshot } from './snapshot.js';
import type { SentrySnapshot } from './snapshot.js';

export const SENTRY_HELP = `frumo sentry: find what drives your Sentry bill and get ready-to-paste fixes with $ estimates.
Unofficial; not affiliated with or endorsed by Functional Software, Inc. (Sentry). Read-only; runs on your machine.

Usage
  frumo sentry demo                       Run on a bundled fictional organization (no account, no network)
  frumo sentry --org <slug>               Live, read-only audit (token in ${SENTRY_TOKEN_ENV})
  frumo sentry --from <snapshot.json>     Offline audit from a snapshot saved with --save-snapshot

Options
  ${SENTRY_TOKEN_ENV.padEnd(27)}Personal auth token (env var only; never pass it as an argument)
  Scopes: ${SENTRY_SCOPES.join(', ')} (nothing wider)
  --org <slug>               Organization slug (sentry.io/organizations/<slug>/)
  --plan team|business       Price list to estimate with (default team)
  --days <n>                 Window to read, 1-${MAX_DAYS} days (default 30); results are scaled to 30 days
  --host <url>               ${DEFAULT_SENTRY_HOST} (default), or https:// self-hosted Sentry
  --save-snapshot <file>     Also save the collected data (no token, DSNs or keys) for offline runs
  --json                     Print the full report as JSON to stdout (progress goes to stderr)
  --full                     Print every code snippet
  --no-color / --color       Force colors off/on (NO_COLOR is respected)
  -q, --quiet                No progress output
  --verbose                  Log each API request (method, path, status; never headers)
  --no-footer                Leave out the waitlist link at the end of the summary
  -h, --help                 Show this help

Estimates use Sentry's public pay-as-you-go list prices, not your invoice.
`;

export interface SentryArgs {
  mode: 'demo' | 'file' | 'live' | 'help';
  org: string | null;
  from: string | null;
  plan: SentryPlan;
  days: number;
  host: string;
  saveSnapshot: string | null;
  json: boolean;
  full: boolean;
  color: boolean | null;
  quiet: boolean;
  verbose: boolean;
  footer: boolean;
}

const TOKEN_FLAG = /^--?(auth[-_]?token|token|api[-_]?key|key|secret|dsn)(=.*)?$/i;

export function parseSentryArgs(argv: readonly string[]): SentryArgs {
  for (const arg of argv) {
    if (TOKEN_FLAG.test(arg) || looksLikeCredential(arg)) {
      throw new UsageError(`Don't pass tokens as command-line arguments: they end up in your shell history. Put the token in ${SENTRY_TOKEN_ENV} instead, e.g.\n  read -rs ${SENTRY_TOKEN_ENV} && export ${SENTRY_TOKEN_ENV}`);
    }
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${message.replace(/\. To specify a positional argument.*$/s, '.')}\nRun "frumo sentry --help" for the options.`);
  }
  const { values, positionals } = parsed;
  if (values.html !== undefined) throw new UsageError('--html is not available for "frumo sentry" yet. Use --json for the full report.');
  if (positionals.length > 1) throw new UsageError(`Unexpected arguments: ${positionals.slice(1).join(' ')}`);
  const command = positionals[0];
  if (command !== undefined && command !== 'demo' && command !== 'help') throw new UsageError(`Unknown command "sentry ${command}". Commands: sentry demo, sentry --org <slug>.`);

  let mode: SentryArgs['mode'];
  if (values.help || command === 'help') mode = 'help';
  else if (command === 'demo') mode = 'demo';
  else if (values.from !== undefined) mode = 'file';
  else if (values.org !== undefined) mode = 'live';
  else throw new UsageError('Nothing to audit. Use "frumo sentry demo" or "frumo sentry --org <slug>".\nRun "frumo sentry --help" for details.');
  if (mode !== 'help' && [command === 'demo', values.from !== undefined, values.org !== undefined].filter(Boolean).length > 1) {
    throw new UsageError('Choose one input: sentry demo, --from <file>, or --org <slug>.');
  }

  const org = values.org?.trim() ?? null;
  if (org !== null && !isSlug(org)) throw new UsageError('--org must be the organization slug, e.g. --org my-company.');
  const planText = (values.plan ?? 'team').trim().toLowerCase();
  if (!(SENTRY_PLANS as readonly string[]).includes(planText)) throw new UsageError(`--plan must be one of: ${SENTRY_PLANS.join(', ')}.`);
  let days = 30;
  if (values.days !== undefined) {
    if (!/^\d+$/.test(values.days.trim())) throw new UsageError('--days must be a whole number.');
    days = Number(values.days);
    if (days < 1 || days > MAX_DAYS) throw new UsageError(`--days must be between 1 and ${MAX_DAYS}.`);
  }
  if (values.color && values['no-color']) throw new UsageError('Use either --color or --no-color.');

  return {
    mode,
    org,
    from: values.from ?? null,
    plan: planText as SentryPlan,
    days,
    host: normalizeSentryHost(values.host ?? DEFAULT_SENTRY_HOST),
    saveSnapshot: values['save-snapshot'] ?? null,
    json: values.json === true,
    full: values.full === true,
    color: values['no-color'] ? false : values.color ? true : null,
    quiet: values.quiet === true,
    verbose: values.verbose === true,
    footer: values['no-footer'] !== true,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      org: { type: 'string' },
      from: { type: 'string' },
      plan: { type: 'string' },
      days: { type: 'string' },
      host: { type: 'string' },
      'save-snapshot': { type: 'string' },
      html: { type: 'string' },
      json: { type: 'boolean' },
      full: { type: 'boolean' },
      color: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      'no-footer': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/** Path of the bundled fictional Sentry org (works from src/ and from dist/). */
export function sentryDemoSnapshotPath(): string {
  return fileURLToPath(new URL('../../fixtures/sentry-demo-snapshot.json', import.meta.url));
}

export async function readSentryDemoSnapshot(): Promise<SentrySnapshot> {
  const text = await readFile(sentryDemoSnapshotPath(), 'utf8');
  return parseSentrySnapshot(JSON.parse(text) as unknown, 'Sentry demo snapshot');
}

async function readSentryFile(path: string): Promise<SentrySnapshot> {
  try {
    if ((await stat(path)).size > 50 * 1024 * 1024) throw new UsageError('--from file is larger than 50 MB.');
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Can't read --from file "${path}" (does it exist?).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`--from file "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSentrySnapshot(json, `Sentry snapshot "${basename(path)}"`);
}

/** Runs `frumo sentry …` (argv without "sentry") and returns the exit code. */
export async function runSentry(argv: readonly string[], io: CliIo): Promise<number> {
  let token: Secret | null = null;
  const secrets = (): Secret[] => (token ? [token] : []);
  let args: SentryArgs | null = null;
  try {
    args = parseSentryArgs(argv);
    if (args.mode === 'help') {
      io.stdout(SENTRY_HELP);
      return 0;
    }
    const quiet = args.quiet;
    const progress = (line: string): void => {
      if (!quiet) io.stderr(`${redact(line, secrets())}\n`);
    };

    let snapshot: SentrySnapshot;
    if (args.mode === 'demo') snapshot = await readSentryDemoSnapshot();
    else if (args.mode === 'file') snapshot = await readSentryFile(args.from ?? '');
    else {
      const value = readSentryToken(io.env);
      if (!value) {
        throw new UsageError(
          `Live mode needs a Sentry personal auth token in ${SENTRY_TOKEN_ENV} with only these scopes: ${SENTRY_SCOPES.join(', ')}.\n  read -rs ${SENTRY_TOKEN_ENV} && export ${SENTRY_TOKEN_ENV}\nTry "frumo sentry demo" to see a report without an account.`,
        );
      }
      token = new Secret(value);
      const verbose = args.verbose;
      const client = new SentryReadOnlyClient({
        origin: args.host,
        token,
        toolVersion: VERSION,
        ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
        log: (line) => {
          if (verbose) io.stderr(`  ${redact(line, secrets())}\n`);
        },
      });
      snapshot = await collectSentrySnapshot(client, {
        org: args.org ?? '',
        days: args.days,
        toolVersion: VERSION,
        progress,
        ...(io.now ? { now: io.now } : {}),
      });
    }

    if (args.saveSnapshot) {
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (token && text.includes(token.reveal())) throw new Error('Refusing to save a snapshot that contains the token.');
      await writeFile(args.saveSnapshot, text, 'utf8');
      progress(`Snapshot saved to ${args.saveSnapshot} (no token, DSNs or keys; reuse it with frumo sentry --from).`);
    }

    const result = runSentryAnalysis(snapshot, { toolVersion: VERSION, plan: args.plan, ...(io.now ? { now: io.now } : {}) });
    if (args.json) io.stdout(renderSentryJson(result));
    else {
      const auto = io.stdoutIsTTY && io.env.NO_COLOR === undefined && io.env.TERM !== 'dumb';
      const forced = io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== '0';
      io.stdout(renderSentryTerminal(result, { color: args.color ?? (forced || auto), width: io.columns ?? 100, full: args.full, footer: args.footer }));
    }
    return 0;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secrets());
    if (error instanceof UsageError) {
      io.stderr(`frumo: ${message}\n`);
      return 2;
    }
    if (error instanceof ApiError || error instanceof ValidationError) {
      io.stderr(`frumo: ${message}\n`);
      return 1;
    }
    io.stderr(`frumo: unexpected error: ${message}\n`);
    if (args?.verbose && error instanceof Error && error.stack) io.stderr(`${redact(error.stack, secrets())}\n`);
    return 1;
  }
}

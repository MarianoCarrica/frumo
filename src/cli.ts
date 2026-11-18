#!/usr/bin/env node
/**
 * HogPost CLI entry point. Unofficial; not affiliated with PostHog Inc.
 * All work happens locally; in live mode the only network peer is the PostHog host you choose.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_KEY_ENV, HELP, parseCliArgs } from './args.js';
import type { CliArgs } from './args.js';
import { runAnalysis } from './analysis/index.js';
import { parsePricingOverride } from './pricing/override.js';
import type { PricingOverride } from './pricing/override.js';
import { renderHtml } from './report/html.js';
import { renderJson } from './report/json.js';
import { renderTerminal } from './report/terminal.js';
import type { Snapshot } from './snapshot.js';
import { readDemoSnapshot, readInputFile } from './sources/file.js';
import { PostHogReadOnlyClient } from './sources/live/client.js';
import { collectSnapshot } from './sources/live/collect.js';
import { normalizeHost } from './sources/live/hosts.js';
import { buildQueries } from './sources/live/queries.js';
import { ApiError, UsageError } from './util/errors.js';
import { Secret, redact } from './util/secret.js';
import { ValidationError } from './util/validate.js';
import { VERSION } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Readonly<Record<string, string | undefined>>;
  stdoutIsTTY: boolean;
  columns?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

/** Runs the CLI and returns the exit code (0 ok, 1 failure, 2 usage error). */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let apiKey: Secret | null = null;
  const secrets = (): Secret[] => (apiKey ? [apiKey] : []);
  let args: CliArgs | null = null;
  try {
    args = parseCliArgs(argv);
    if (args.mode === 'help') {
      io.stdout(HELP);
      return 0;
    }
    if (args.mode === 'version') {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (args.mode === 'print-queries') {
      io.stdout(printQueries(args.days));
      return 0;
    }

    const progress = (line: string): void => {
      if (!args?.quiet) io.stderr(`${line}\n`);
    };
    const pricingOverride = args.pricing ? await loadPricing(args.pricing) : null;

    let snapshot: Snapshot;
    if (args.mode === 'demo') {
      snapshot = await readDemoSnapshot();
    } else if (args.mode === 'file') {
      snapshot = await readInputFile(args.from ?? '', { days: args.days, toolVersion: VERSION, ...(io.now ? { now: io.now } : {}) });
    } else {
      const raw = io.env[API_KEY_ENV]?.trim();
      if (!raw) {
        throw new UsageError(
          `Live mode needs a PostHog personal API key in ${API_KEY_ENV} (read-only scopes: query:read; recommended billing:read, project:read, feature_flag:read).\n  read -rs ${API_KEY_ENV} && export ${API_KEY_ENV}\nTry "hogpost demo" to see a report without an account.`,
        );
      }
      apiKey = new Secret(raw);
      const host = normalizeHost(args.host, { allowHttp: args.allowHttp });
      for (const note of host.notes) progress(note);
      const verbose = args.verbose;
      const client = new PostHogReadOnlyClient({
        origin: host.origin,
        apiKey,
        toolVersion: VERSION,
        ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
        log: (line) => {
          if (verbose) io.stderr(`  ${redact(line, secrets())}\n`);
        },
      });
      snapshot = await collectSnapshot(client, {
        projectId: args.projectId ?? '',
        days: args.days,
        toolVersion: VERSION,
        progress: (line) => progress(redact(line, secrets())),
        ...(io.now ? { now: io.now } : {}),
      });
    }

    if (args.saveSnapshot) {
      const text = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (apiKey && text.includes(apiKey.reveal())) throw new Error('Refusing to save a snapshot that contains the API key.');
      await writeFile(args.saveSnapshot, text, 'utf8');
      progress(`Snapshot saved to ${args.saveSnapshot} (no credentials; reuse it with --from).`);
    }

    const result = runAnalysis(snapshot, {
      toolVersion: VERSION,
      marketingPatterns: args.marketingUrl,
      appPatterns: args.appUrl,
      devHostPatterns: args.devHost,
      serverInstances: args.serverInstances,
      pricingOverride,
      usePlanPricing: args.planPricing,
      ...(io.now ? { now: io.now } : {}),
    });

    if (args.json) io.stdout(renderJson(result));
    else {
      const auto = io.stdoutIsTTY && io.env.NO_COLOR === undefined && io.env.TERM !== 'dumb';
      const forced = io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== '0';
      const color = args.color ?? (forced || auto);
      io.stdout(renderTerminal(result, { color, width: io.columns ?? 100, full: args.full }));
    }
    if (args.html) {
      await writeFile(args.html, renderHtml(result), 'utf8');
      const message = `HTML report written to ${args.html}\n`;
      if (args.json) io.stderr(message);
      else io.stdout(message);
    } else if (!args.json && !args.quiet) {
      io.stdout('Tip: --html report.html writes the full report with evidence tables and copy buttons.\n');
    }
    return 0;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), secrets());
    if (error instanceof UsageError) {
      io.stderr(`hogpost: ${message}\n`);
      return 2;
    }
    if (error instanceof ApiError || error instanceof ValidationError) {
      io.stderr(`hogpost: ${message}\n`);
      return 1;
    }
    io.stderr(`hogpost: unexpected error: ${message}\n`);
    if (args?.verbose && error instanceof Error && error.stack) io.stderr(`${redact(error.stack, secrets())}\n`);
    return 1;
  }
}

async function loadPricing(path: string): Promise<PricingOverride> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new UsageError(`Can't read --pricing file "${path}".`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--pricing file "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsePricingOverride(json, `Pricing file "${path}"`);
}

function printQueries(days: number): string {
  const lines = [
    `-- Every HogQL query HogPost runs in live mode (window: last ${days} days).`,
    '-- All are read-only SELECTs sent to POST /api/projects/:id/query/ (scope query:read).',
    '-- Paste any of them into PostHog\'s SQL editor to check them yourself.',
    '',
  ];
  for (const q of buildQueries(days)) lines.push(`-- ${q.name}: ${q.purpose}`, `${q.sql};`, '');
  return `${lines.join('\n')}`;
}

/** True when this module is the process entry point (also through the npm bin symlink). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
  };
  main(process.argv.slice(2), io).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`hogpost: ${redact(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    },
  );
}

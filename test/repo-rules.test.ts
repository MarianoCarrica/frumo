/**
 * Mechanical rules for the codebase, enforced as tests so they can't drift.
 * Each failure message says how to fix the root cause.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_KEY_ENV, LEGACY_API_KEY_ENV } from '../src/api-key.js';
import { HELP } from '../src/args.js';
import { PUBLIC_PRICING, SENTRY_PUBLIC_PRICING } from '../src/pricing/public-pricing.js';
import { PRODUCT_KEYS, SENTRY_BILLED_CATEGORIES, SENTRY_PLANS } from '../src/pricing/types.js';
import { SENTRY_TOKEN_ENV } from '../src/sentry/auth-token.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(srcDir).map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));

/** Source with comments and string literals blanked out, so rules only see code. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\/.*$/gm, '');
}

describe('repository rules', () => {
  it('keeps every price in src/pricing/public-pricing.ts', () => {
    const offenders = files
      .filter((f) => f.path !== join('src', 'pricing', 'public-pricing.ts'))
      .filter((f) => /\b0\.0000?\d+/.test(codeOnly(f.text)));
    expect(
      offenders.map((f) => f.path),
      'Per-unit prices belong in src/pricing/public-pricing.ts (or a --pricing file). Import PUBLIC_PRICING instead of hard-coding a price.',
    ).toEqual([]);
  });

  it('uses only APIs available in Node.js 18 (package engines >=18.18)', () => {
    const forbidden: Array<[RegExp, string]> = [
      [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(\d/, 'ES2023 array copies need Node 20; use [...arr].sort()'],
      [/Object\.groupBy|Map\.groupBy/, 'groupBy needs Node 21; reduce into a Map instead'],
      [/import\.meta\.(dirname|filename)/, 'import.meta.dirname needs Node 20.11; use fileURLToPath(new URL(".", import.meta.url))'],
      [/Promise\.withResolvers|Array\.fromAsync/, 'needs Node 22; write the equivalent by hand'],
      [/\.(union|intersection|difference|symmetricDifference|isSubsetOf)\(/, 'Set methods need Node 22; loop instead'],
      [/process\.loadEnvFile|util\.styleText|styleText\(/, 'needs Node 20.12+/21; avoid'],
    ];
    const problems: string[] = [];
    for (const f of files) for (const [re, fix] of forbidden) if (re.test(f.text)) problems.push(`${f.path}: ${fix}`);
    expect(problems).toEqual([]);
  });

  it('has no invisible control or format characters (they break regex literals and hide in diffs)', () => {
    const invisible = (code: number): boolean =>
      (code < 32 && code !== 10 && code !== 9 && code !== 13) || code === 0x2028 || code === 0x2029 || code === 0xfeff || (code >= 0x200b && code <= 0x200f);
    const bad = files.filter((f) => [...f.text].some((ch) => invisible(ch.codePointAt(0) ?? 0))).map((f) => f.path);
    expect(bad, 'Build such characters at runtime, e.g. String.fromCharCode(0xfeff), instead of pasting them into the source').toEqual([]);
  });

  it('never reads environment variables other than the documented ones', () => {
    // HOGPOST_API_KEY is the deprecated pre-rename name, still read as a fallback for FRUMO_API_KEY.
    // SENTRY_AUTH_TOKEN is read only by `frumo sentry` (src/sentry/auth-token.ts).
    const allowed = new Set(['FRUMO_API_KEY', 'HOGPOST_API_KEY', 'SENTRY_AUTH_TOKEN', 'NO_COLOR', 'FORCE_COLOR', 'TERM']);
    expect(API_KEY_ENV).toBe('FRUMO_API_KEY');
    expect(LEGACY_API_KEY_ENV).toBe('HOGPOST_API_KEY');
    expect(SENTRY_TOKEN_ENV).toBe('SENTRY_AUTH_TOKEN');
    // env[CONSTANT] reads are resolved through the real constants, so the fallback read is checked too.
    const constants: Record<string, string> = { API_KEY_ENV, LEGACY_API_KEY_ENV, SENTRY_TOKEN_ENV };
    const used = new Set<string>();
    for (const f of files) {
      for (const m of codeOnly(f.text).matchAll(/\b(?:env|process\.env)(?:\.([A-Z_]+)|\[['"]([A-Z_]+)['"]\])/g)) used.add(m[1] ?? m[2] ?? '');
      for (const m of codeOnly(f.text).matchAll(/\benv\[([A-Za-z_$][\w$]*)\]/g)) {
        const id = m[1] ?? '';
        used.add(constants[id] ?? `env[${id}] in ${f.path}`);
      }
    }
    for (const name of used) {
      expect(
        allowed.has(name),
        `${name} is read from the environment. Read variables by literal name or through the constants in src/api-key.ts, and document any new one in --help and the README`,
      ).toBe(true);
    }
    expect(HELP, 'document the deprecated key variable in --help').toContain(LEGACY_API_KEY_ENV);
    expect(HELP, 'document the Sentry token variable in --help').toContain(SENTRY_TOKEN_ENV);
  });

  it('reads the Sentry token from the environment only in src/sentry/auth-token.ts', () => {
    const tokenRead = /\benv(?:\.SENTRY_AUTH_TOKEN\b|\[\s*SENTRY_TOKEN_ENV\s*\])/;
    const offenders = files.filter((f) => f.path !== join('src', 'sentry', 'auth-token.ts') && tokenRead.test(codeOnly(f.text))).map((f) => f.path);
    expect(offenders, 'Call readSentryToken() from src/sentry/auth-token.ts instead of reading SENTRY_AUTH_TOKEN directly').toEqual([]);
  });

  it('reads the API key from the environment only in src/api-key.ts', () => {
    const keyRead = /\benv(?:\.(?:FRUMO|HOGPOST)_API_KEY\b|\[\s*(?:API_KEY_ENV|LEGACY_API_KEY_ENV)\s*\])/;
    const offenders = files.filter((f) => f.path !== join('src', 'api-key.ts') && keyRead.test(codeOnly(f.text))).map((f) => f.path);
    expect(offenders, 'Call readApiKey() from src/api-key.ts so the FRUMO_API_KEY → HOGPOST_API_KEY fallback stays in one place').toEqual([]);
  });

  it('never uses HTTP methods other than GET and the query POST in the live client', () => {
    const client = files.find((f) => f.path.endsWith(join('live', 'client.ts')))?.text ?? '';
    expect(client).not.toMatch(/method:\s*['"](PUT|PATCH|DELETE)['"]/);
    const collect = files.find((f) => f.path.endsWith(join('live', 'collect.ts')))?.text ?? '';
    expect(collect, 'collect.ts must go through the read-only client, never fetch() directly').not.toMatch(/\bfetch\(/);
  });

  it('sends only GET requests from the Sentry client', () => {
    const client = files.find((f) => f.path === join('src', 'sentry', 'client.ts'))?.text ?? '';
    const methods = [...client.matchAll(/method:\s*['"]([A-Z]+)['"]/g)].map((m) => m[1]);
    expect(methods.length, 'the Sentry client must set its method explicitly').toBeGreaterThan(0);
    expect(methods.every((m) => m === 'GET'), 'frumo sentry is read-only: send GET only, never POST/PUT/PATCH/DELETE').toBe(true);
    const collect = files.find((f) => f.path === join('src', 'sentry', 'collect.ts'))?.text ?? '';
    expect(collect, 'src/sentry/collect.ts must go through SentryReadOnlyClient, never fetch() directly').not.toMatch(/\bfetch\(/);
  });

  it('keeps the waitlist URL in src/report/waitlist.ts only', () => {
    const offenders = files.filter((f) => f.path !== join('src', 'report', 'waitlist.ts') && /frumo\.marianoventures\.com/i.test(f.text)).map((f) => f.path);
    expect(offenders, 'Import WAITLIST_URL or waitlistUrl() from src/report/waitlist.ts instead of copying the waitlist URL').toEqual([]);
  });

  it('makes network requests only from the read-only PostHog and Sentry clients (no telemetry, no browser opening)', () => {
    const clients = [join('src', 'sources', 'live', 'client.ts'), join('src', 'sentry', 'client.ts')];
    const netModule = /from\s+['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)['"]|import\(\s*['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)['"]/;
    const problems: string[] = [];
    for (const f of files) {
      if (netModule.test(f.text)) problems.push(`${f.path}: imports a network or process module`);
      if (!clients.includes(f.path) && /\bfetch\s*\(|\b(?:globalThis|window|global)\.fetch\b|\bXMLHttpRequest\b|\bsendBeacon\b/.test(codeOnly(f.text))) {
        problems.push(`${f.path}: calls fetch`);
      }
    }
    expect(
      problems,
      'frumo talks only to the host the user chose, through PostHogReadOnlyClient (src/sources/live/client.ts) or SentryReadOnlyClient (src/sentry/client.ts). Print a link instead of requesting a URL or opening a browser.',
    ).toEqual([]);
  });

  it('keeps package metadata as required (name, licence, repository, version in sync)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg.name).toBe('frumo-cli');
    expect(pkg.version).toBe(VERSION);
    expect(pkg.license).toBe('MIT');
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/MarianoCarrica/frumo.git' });
    expect(pkg.homepage).toBe('https://github.com/MarianoCarrica/frumo#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/MarianoCarrica/frumo/issues' });
    expect(pkg.publishConfig).toEqual({ access: 'public' });
    expect(pkg.bin).toEqual({ frumo: 'dist/cli.js' });
    expect(pkg.files, 'ship both demo fixtures, or "frumo demo" / "frumo sentry demo" fail after npm install').toEqual(
      expect.arrayContaining(['fixtures/demo-snapshot.json', 'fixtures/sentry-demo-snapshot.json']),
    );
    expect(String(pkg.name), "PostHog's terms bar third-party apps from using \"PostHog\" in their name").not.toMatch(/posthog/i);
    expect((pkg.engines as Record<string, string>).node).toBe('>=18.18');
    const deps = Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {});
    expect(deps, 'frumo has zero runtime dependencies').toEqual([]);
    const license = readFileSync(join(root, 'LICENSE'), 'utf8');
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Copyright \(c\) 2026 Mariano Ventures/);
  });

  it('keeps the README in sync with --help, the price list and the required disclaimer', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const usage = HELP.slice(HELP.indexOf('Usage'), HELP.indexOf('\nExamples')).trimEnd();
    expect(readme.includes(usage), 'Regenerate the README "CLI reference" block from `frumo --help`').toBe(true);
    expect(readme).toContain('Unofficial. Not affiliated with or endorsed by PostHog Inc. Works with PostHog Cloud (US/EU) and self-hosted PostHog.');
    expect(readme).toContain(`retrieved ${PUBLIC_PRICING.retrieved}`);
    const workingOnThisRepo =
      '## Working on this repo\n\nRead [AGENTS.md](AGENTS.md) before making changes. Pull requests must pass the CI checks: `lint`, `typecheck` and `test`.';
    expect(readme.trimEnd().endsWith(workingOnThisRepo), 'README.md must end with the upstream "Working on this repo" section, verbatim').toBe(true);
    expect(readme, 'README "Sentry" section must state when the Sentry prices were checked').toContain(`checked ${SENTRY_PUBLIC_PRICING.retrieved}`);
    for (const category of SENTRY_BILLED_CATEGORIES) {
      for (const plan of SENTRY_PLANS) {
        for (const tier of SENTRY_PUBLIC_PRICING.categories[category].tiers[plan]) {
          if (tier.unitUsd > 0) {
            expect(readme, `README Sentry pricing table is missing ${category} (${plan}) at $${tier.unitUsd}; copy it from SENTRY_PUBLIC_PRICING`).toContain(`$${tier.unitUsd}`);
          }
        }
      }
    }
    for (const key of PRODUCT_KEYS) {
      for (const tier of PUBLIC_PRICING.products[key].tiers ?? []) {
        if (tier.unitUsd > 0) {
          expect(readme, `README pricing table is missing ${key} at $${tier.unitUsd}; copy it from src/pricing/public-pricing.ts`).toContain(`$${tier.unitUsd}`);
        }
      }
    }
  });

  it('keeps lint, typecheck and test runnable straight after npm ci (CI runs them without a build)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const script of ['lint', 'typecheck', 'test']) {
      expect(pkg.scripts[script], `package.json needs a "${script}" script for CI`).toBeTypeOf('string');
      expect(pkg.scripts[script], `"${script}" must not depend on a build: CI runs it right after npm ci`).not.toMatch(/\b(build|dist)\b/);
    }
    for (const name of readdirSync(join(root, 'test'))) {
      const text = readFileSync(join(root, 'test', name), 'utf8');
      expect(text, `test/${name} imports from dist/; import from ../src so tests run without a build`).not.toMatch(/from ['"][^'"]*\/dist\//);
    }
  });

  it('ships the CLI with a node shebang', () => {
    const cli = files.find((f) => f.path === join('src', 'cli.ts'))?.text ?? '';
    expect(cli.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

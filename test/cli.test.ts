import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exitOnBrokenPipe, main } from '../src/cli.js';
import type { CliIo } from '../src/cli.js';
import type { AuditResult } from '../src/analysis/model.js';
import { SNAPSHOT_SCHEMA } from '../src/snapshot.js';
import { PROJECT, fakePostHog } from './fake-posthog.js';
import { NOW, noSleep } from './helpers.js';

const KEY = 'phx_CLIKEY0123456789abcdefghijklmnopqrstuvw';
/** Start of an ANSI escape sequence (ESC + "["). */
const ANSI = `${String.fromCharCode(27)}[`;
const dir = mkdtempSync(join(tmpdir(), 'frumo-test-'));

function io(env: Record<string, string> = {}, fetchImpl?: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    stdoutIsTTY: false,
    now: NOW,
    sleep: noSleep,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  return { io: value, out: () => out.join(''), err: () => err.join('') };
}

describe('CLI end to end', () => {
  it('runs the demo with a readable terminal summary', async () => {
    const t = io();
    expect(await main(['demo'], t.io)).toBe(0);
    const text = t.out();
    for (const heading of ['ESTIMATED MONTHLY BILL', 'POTENTIAL SAVING', 'TOP COST DRIVERS', 'FIXES', 'POSTHOG.INIT CHANGES', 'BILLING LIMITS', 'HOW URLS WERE CLASSIFIED']) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/Total\s+\$1,568/);
    expect(text).toContain('not affiliated with PostHog Inc.');
    expect(text).toContain('Demo data: a fictional company');
    expect(text).not.toContain(ANSI); // no colors when not a TTY
  });

  it('prints colors only on a TTY without NO_COLOR', async () => {
    const tty = io();
    tty.io.stdoutIsTTY = true;
    await main(['demo'], tty.io);
    expect(tty.out()).toContain(`${ANSI}1m`);
    const noColor = io({ NO_COLOR: '1' });
    noColor.io.stdoutIsTTY = true;
    await main(['demo'], noColor.io);
    expect(noColor.out()).not.toContain(ANSI);
  });

  it('emits machine-readable JSON on stdout only', async () => {
    const t = io();
    expect(await main(['demo', '--json'], t.io)).toBe(0);
    const result = JSON.parse(t.out()) as AuditResult;
    expect(result.schema).toBe('frumo.report/v1');
    expect(result.tool.name).toBe('frumo');
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.costs.totalUsd).toBeCloseTo(1568, 0);
    expect(result.fixes.length).toBeGreaterThan(10);
    expect(result.pricing.table.source).toBe('https://posthog.com/pricing');
    expect(result.disclaimer).toMatch(/not affiliated/);
  });

  it('writes a self-contained HTML report that loads nothing from the network', async () => {
    const file = join(dir, 'report.html');
    const t = io();
    expect(await main(['demo', '--html', file, '--quiet'], t.io)).toBe(0);
    const html = readFileSync(file, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/@import/i);
    for (const href of html.match(/href="[^"]+"/g) ?? []) expect(href).toMatch(/^href="(#|https:\/\/posthog\.com\/|https:\/\/us\.posthog\.com\/)/);
    expect(html).toContain('Unofficial · not affiliated with PostHog Inc.');
    expect(html).toContain('<title>frumo · Demo: Tidebrook (fictional B2B SaaS)</title>');
    expect(html).toMatch(/<h1[^>]*>frumo · Demo: Tidebrook/);
    expect(html).not.toMatch(/hogpost/i);
    expect(html).toContain('person_profiles');
    expect(t.out()).toContain(`HTML report written to ${file}`);
  });

  it('escapes hostile data in the HTML report', async () => {
    const snapPath = join(dir, 'hostile.json');
    writeFileSync(
      snapPath,
      JSON.stringify({
        schema: SNAPSHOT_SCHEMA,
        period: { days: 30 },
        events: {
          totals: { billable: 2_000_000 },
          byEvent: [{ event: '<script>alert(1)</script>', count: 2_000_000, identified: null }],
        },
      }),
    );
    const file = join(dir, 'hostile.html');
    expect(await main(['--from', snapPath, '--html', file, '--quiet'], io().io)).toBe(0);
    const html = readFileSync(file, 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('saves a snapshot and reproduces the same audit offline', async () => {
    const snapPath = join(dir, 'demo-snapshot.json');
    const first = io();
    expect(await main(['demo', '--json', '--save-snapshot', snapPath], first.io)).toBe(0);
    const second = io();
    expect(await main(['--from', snapPath, '--json'], second.io)).toBe(0);
    const a = JSON.parse(first.out()) as AuditResult;
    const b = JSON.parse(second.out()) as AuditResult;
    expect(b.costs.totalUsd).toBeCloseTo(a.costs.totalUsd, 6);
    expect(b.savings.allUsd).toBeCloseTo(a.savings.allUsd, 6);
  });

  it('audits a CSV of event counts', async () => {
    const csv = join(dir, 'counts.csv');
    writeFileSync(csv, 'event,count\n$autocapture,4000000\n$pageview,1000000\n$pageleave,800000\n');
    const t = io();
    expect(await main(['--from', csv, '--days', '30'], t.io)).toBe(0);
    expect(t.out()).toContain('CSV event counts: counts.csv');
    expect(t.out()).toContain('Stop automatic $pageleave events');
  });

  it('applies a --pricing override file', async () => {
    const pricing = join(dir, 'pricing.json');
    writeFileSync(pricing, JSON.stringify({ name: 'Our contract', retrieved: '2026-10-01', discountPercent: 20, products: {} }));
    const t = io();
    expect(await main(['demo', '--pricing', pricing, '--json'], t.io)).toBe(0);
    const result = JSON.parse(t.out()) as AuditResult;
    expect(result.pricing.table.name).toBe('Our contract');
    expect(result.costs.discountUsd).toBeCloseTo(result.costs.subtotalUsd * 0.2, 6);
  });

  it('runs live against a (fake) PostHog without ever exposing the key', async () => {
    const fake = fakePostHog();
    const snapPath = join(dir, 'live-snapshot.json');
    const t = io({ FRUMO_API_KEY: KEY }, fake.fetch);
    const code = await main(['--project', PROJECT, '--verbose', '--save-snapshot', snapPath, '--html', join(dir, 'live.html')], t.io);
    expect(t.err()).not.toContain(KEY);
    expect(code).toBe(0);
    expect(t.out()).toContain('Live, read-only: https://us.posthog.com');
    expect(t.out()).not.toContain(KEY);
    expect(t.err()).toMatch(/GET \/api\/billing\/ → 200/);
    expect(readFileSync(snapPath, 'utf8')).not.toContain(KEY);
    expect(readFileSync(join(dir, 'live.html'), 'utf8')).not.toContain(KEY);
    expect(fake.calls.every((c) => c.method === 'GET' || c.url.pathname === `/api/projects/${PROJECT}/query/`)).toBe(true);
  });

  it('redacts the key from API errors', async () => {
    const leaky = () => Promise.resolve(new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: 401 }));
    const t = io({ FRUMO_API_KEY: KEY }, leaky);
    expect(await main(['--project', PROJECT], t.io)).toBe(1);
    expect(t.err()).toMatch(/401/);
    expect(t.err()).not.toContain(KEY);
  });

  it('explains how to provide the key and refuses it as an argument', async () => {
    const missing = io();
    expect(await main(['--project', '1'], missing.io)).toBe(2);
    expect(missing.err()).toContain('Live mode needs a PostHog personal API key in FRUMO_API_KEY');
    expect(missing.err()).toContain('read -rs FRUMO_API_KEY && export FRUMO_API_KEY');
    expect(missing.err()).toContain('Try "frumo demo"');
    expect(missing.err()).toMatch(/^frumo: /);
    const blanks: Array<Record<string, string>> = [{ FRUMO_API_KEY: '' }, { FRUMO_API_KEY: '  ', HOGPOST_API_KEY: ' ' }];
    for (const blank of blanks) {
      const empty = io(blank);
      expect(await main(['--project', '1'], empty.io)).toBe(2);
      expect(empty.err()).toContain('API key in FRUMO_API_KEY');
    }
    const asArg = io();
    expect(await main(['--project', '1', '--api-key', KEY], asArg.io)).toBe(2);
    expect(asArg.err()).toMatch(/shell history/);
    expect(asArg.err()).not.toContain(KEY);
  });

  describe('API key variable', () => {
    const OLD_KEY = 'phx_OLDKEY0123456789abcdefghijklmnopqrstuvw';
    const sentKeys = (calls: ReturnType<typeof fakePostHog>['calls']) => new Set(calls.map((c) => c.headers.authorization));

    it('runs live with only FRUMO_API_KEY set', async () => {
      const fake = fakePostHog();
      const t = io({ FRUMO_API_KEY: KEY }, fake.fetch);
      expect(await main(['--project', PROJECT, '--json'], t.io)).toBe(0);
      expect(sentKeys(fake.calls)).toEqual(new Set([`Bearer ${KEY}`]));
      expect(fake.calls.every((c) => /^frumo\//.test(c.headers['user-agent'] ?? ''))).toBe(true);
      expect(t.err()).not.toMatch(/deprecated/);
      expect((JSON.parse(t.out()) as AuditResult).schema).toBe('frumo.report/v1');
    });

    it('still runs live with only the deprecated HOGPOST_API_KEY set, and says to rename it', async () => {
      const fake = fakePostHog();
      const t = io({ HOGPOST_API_KEY: OLD_KEY }, fake.fetch);
      expect(await main(['--project', PROJECT, '--json'], t.io)).toBe(0);
      expect(fake.calls.length).toBeGreaterThan(0);
      expect(sentKeys(fake.calls)).toEqual(new Set([`Bearer ${OLD_KEY}`]));
      expect(t.err()).toContain('Using the key from HOGPOST_API_KEY, which is deprecated: rename it to FRUMO_API_KEY.');
      expect(t.err()).not.toContain(OLD_KEY);
      const quiet = io({ HOGPOST_API_KEY: OLD_KEY }, fakePostHog().fetch);
      expect(await main(['--project', PROJECT, '--json', '--quiet'], quiet.io)).toBe(0);
      expect(quiet.err()).toBe('');
    });

    it('prefers FRUMO_API_KEY when both are set, and falls back when it is empty', async () => {
      const both = fakePostHog();
      const t = io({ FRUMO_API_KEY: KEY, HOGPOST_API_KEY: OLD_KEY }, both.fetch);
      expect(await main(['--project', PROJECT, '--json'], t.io)).toBe(0);
      expect(sentKeys(both.calls)).toEqual(new Set([`Bearer ${KEY}`]));
      expect(t.err()).not.toMatch(/deprecated/);

      const blank = fakePostHog();
      expect(await main(['--project', PROJECT, '--json', '--quiet'], io({ FRUMO_API_KEY: ' ', HOGPOST_API_KEY: OLD_KEY }, blank.fetch).io)).toBe(0);
      expect(sentKeys(blank.calls)).toEqual(new Set([`Bearer ${OLD_KEY}`]));
    });

    it('names the variable the rejected key came from', async () => {
      const reject = () => Promise.resolve(new Response('{}', { status: 401 }));
      const current = io({ FRUMO_API_KEY: KEY }, reject);
      expect(await main(['--project', PROJECT], current.io)).toBe(1);
      expect(current.err()).toContain('rejected the API key in FRUMO_API_KEY');
      const legacy = io({ HOGPOST_API_KEY: OLD_KEY }, reject);
      expect(await main(['--project', PROJECT], legacy.io)).toBe(1);
      expect(legacy.err()).toContain('rejected the API key in HOGPOST_API_KEY');
    });
  });

  it('reads snapshots saved before the rename (hogpost.snapshot/v1)', async () => {
    const current = join(dir, 'current-schema.json');
    const legacy = join(dir, 'legacy-schema.json');
    const a = io();
    expect(await main(['demo', '--json', '--quiet', '--save-snapshot', current], a.io)).toBe(0);
    const saved = JSON.parse(readFileSync(current, 'utf8')) as { schema: string };
    expect(saved.schema).toBe('frumo.snapshot/v1');
    writeFileSync(legacy, JSON.stringify({ ...saved, schema: 'hogpost.snapshot/v1' }));
    const b = io();
    expect(await main(['--from', legacy, '--json'], b.io)).toBe(0);
    expect((JSON.parse(b.out()) as AuditResult).costs.totalUsd).toBeCloseTo((JSON.parse(a.out()) as AuditResult).costs.totalUsd, 6);
  });

  it('prints the queries, help and version', async () => {
    const q = io();
    expect(await main(['--print-queries', '--days', '14'], q.io)).toBe(0);
    const statements = q.out().split(';\n').filter((s) => s.trim().length > 0 && /SELECT/i.test(s));
    expect(statements.length).toBe(13);
    expect(q.out()).toContain('INTERVAL 14 DAY');
    const h = io();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.out()).toContain('FRUMO_API_KEY              Personal API key');
    expect(h.out()).toContain('HOGPOST_API_KEY            Deprecated old name, still read when FRUMO_API_KEY is unset');
    expect(h.out()).toMatch(/^frumo: /);
    expect(h.out()).toContain('  frumo demo ');
    expect(h.out()).toContain('npx frumo --project 12345');
    expect(h.out()).not.toMatch(/hogpost(?!_API_KEY)/i);
    expect(h.out()).toContain('not affiliated with or endorsed by PostHog Inc.');
    const v = io();
    expect(await main(['--version'], v.io)).toBe(0);
    expect(v.out().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fails cleanly on bad input', async () => {
    const t = io();
    expect(await main(['--from', join(dir, 'missing.json')], t.io)).toBe(2);
    expect(t.err()).toMatch(/Can't read --from file/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"schema":"frumo.snapshot/v1","period":{"days":-1}}');
    const v = io();
    expect(await main(['--from', bad], v.io)).toBe(1);
    expect(v.err()).toMatch(/period\.days/);
  });
});

describe('piping output', () => {
  it('exits quietly when the reader closes the pipe (frumo demo | head) and rethrows other errors', () => {
    const stream = new EventEmitter();
    const codes: number[] = [];
    exitOnBrokenPipe(stream, (code) => codes.push(code));
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(codes).toEqual([0]);
    expect(() => stream.emit('error', Object.assign(new Error('disk on fire'), { code: 'EIO' }))).toThrow('disk on fire');
  });
});

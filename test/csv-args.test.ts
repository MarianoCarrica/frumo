import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/args.js';
import { parseCsvLine, parseEventCountsCsv, snapshotFromEventCounts } from '../src/sources/csv.js';
import { UsageError } from '../src/util/errors.js';
import { ValidationError } from '../src/util/validate.js';
import { analyze } from './helpers.js';

describe('CSV of event counts', () => {
  it('reads a headed CSV with an identified column and merges duplicates', () => {
    const rows = parseEventCountsCsv('event,count,identified\n$autocapture,"3,620,000",2050000\n$pageview,1240000,\n$pageview,10000,\n');
    expect(rows).toEqual([
      { event: '$autocapture', count: 3_620_000, identified: 2_050_000 },
      { event: '$pageview', count: 1_250_000, identified: null },
    ]);
  });

  it('reads headerless, semicolon and tab separated files and PostHog SQL editor headers', () => {
    expect(parseEventCountsCsv('$pageview,100\nsignup,5')).toHaveLength(2);
    expect(parseEventCountsCsv('event;count\n$pageview;100')[0]).toEqual({ event: '$pageview', count: 100, identified: null });
    expect(parseEventCountsCsv('event\tcount()\n$pageview\t7')[0]?.count).toBe(7);
    expect(parseEventCountsCsv(`${String.fromCharCode(0xfeff)}count,event\n5,"say ""hi"""`)[0]).toEqual({ event: 'say "hi"', count: 5, identified: null });
    expect(parseCsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });

  it('reports bad rows with line numbers', () => {
    expect(() => parseEventCountsCsv('event,count\n$pageview,lots\n,5')).toThrow(ValidationError);
    try {
      parseEventCountsCsv('event,count,identified\n$pageview,lots\n,5\nx,5,9');
    } catch (error) {
      const issues = (error as ValidationError).issues.join('\n');
      expect(issues).toMatch(/line 2: count "lots" is not a number/);
      expect(issues).toMatch(/line 3: missing event name/);
      expect(issues).toMatch(/line 4: identified \(9\) is larger than count \(5\)/);
    }
    expect(() => parseEventCountsCsv('   \n')).toThrow(/empty/);
  });

  it('turns counts into a snapshot the analysis can use, and says what is missing', () => {
    const snap = snapshotFromEventCounts(parseEventCountsCsv('event,count\n$autocapture,3000000\n$pageleave,900000\n$feature_flag_called,400000'), {
      days: 30,
      toolVersion: 'test',
      label: 'counts.csv',
    });
    expect(snap.events?.totals.billable).toBe(3_900_000);
    expect(snap.events?.totals.billableIdentified).toBeNull();
    const result = analyze(snap);
    expect(result.costs.totalUsd).toBeGreaterThan(0);
    expect(result.input.scope).toBe('project');
    expect(result.fixes.map((f) => f.id)).toContain('pageleave-off');
    expect(result.notAnalyzed.join(' ')).toMatch(/Feature flag requests/);
    expect(result.notes.join(' ')).toMatch(/No identified column/);
  });
});

describe('command-line arguments', () => {
  it('picks the mode', () => {
    expect(parseCliArgs(['demo']).mode).toBe('demo');
    expect(parseCliArgs(['--demo', '--json']).json).toBe(true);
    expect(parseCliArgs(['--from', 'x.json']).mode).toBe('file');
    expect(parseCliArgs(['--project', '123']).mode).toBe('live');
    expect(parseCliArgs(['audit', '--project', '123', '--host', 'https://eu.posthog.com']).host).toBe('https://eu.posthog.com');
    expect(parseCliArgs(['--print-queries']).mode).toBe('print-queries');
    expect(parseCliArgs(['queries', '--days', '7']).days).toBe(7);
    expect(parseCliArgs(['-h']).mode).toBe('help');
    expect(parseCliArgs(['-v']).mode).toBe('version');
  });

  it('parses repeatable patterns and numbers', () => {
    const args = parseCliArgs(['demo', '--marketing-url', 'blog', '--marketing-url', '^https://www', '--dev-host', 'qa\\.', '--server-instances', '12', '--public-pricing', '--no-color']);
    expect(args.marketingUrl.map(String)).toEqual(['/blog/i', '/^https:\\/\\/www/i']);
    expect(args.devHost).toHaveLength(1);
    expect(args.serverInstances).toBe(12);
    expect(args.planPricing).toBe(false);
    expect(args.color).toBe(false);
  });

  it('rejects API keys passed as arguments without echoing them', () => {
    const key = 'phx_ARGKEY0123456789abcdefghijklmnopqrstu';
    for (const argv of [['--api-key', key], [`--api-key=${key}`], ['--project', '1', key], ['--token', 'x'], ['--personal-api-key=abc']]) {
      try {
        parseCliArgs(argv);
        expect.unreachable(argv.join(' '));
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as Error).message).toMatch(/shell history/);
        expect((error as Error).message).not.toContain(key);
      }
    }
  });

  it('validates input with helpful messages', () => {
    expect(() => parseCliArgs([])).toThrow(/Nothing to audit/);
    expect(() => parseCliArgs(['--project', 'my-project'])).toThrow(/numeric project ID/);
    expect(() => parseCliArgs(['--project', '1', '--days', '365'])).toThrow(/between 1 and 90/);
    expect(parseCliArgs(['--from', 'counts.csv', '--days', '365']).days).toBe(365);
    expect(() => parseCliArgs(['--project', '1', '--from', 'x.json'])).toThrow(/Choose one input/);
    expect(() => parseCliArgs(['demo', '--marketing-url', '('])).toThrow(/not a valid regular expression/);
    expect(() => parseCliArgs(['demo', '--frobnicate'])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(['launch'])).toThrow(/Unknown command/);
    expect(() => parseCliArgs(['demo', '--color', '--no-color'])).toThrow(/either/);
  });
});

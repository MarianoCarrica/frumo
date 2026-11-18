import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyEffects, costBreakdown, savingBetween } from '../src/analysis/costs.js';
import { niceLimit } from '../src/analysis/index.js';
import { buildInitDiff, devHostRegexSource, escapeRegex, ingestionHost, jsString } from '../src/analysis/snippets.js';
import { UrlClassifier, devHostReason, displayPath, parseUrlLoose } from '../src/analysis/url-class.js';
import { publicPricing } from '../src/pricing/override.js';
import { analyze, context, demo, snapshot, usage } from './helpers.js';

/** Compiles JavaScript without running it (async body allowed for top-level await in snippets). */
function compiles(code: string): void {
  const body = code.replace(/^\s*import .*$/gm, '').replace(/^export /gm, '');
  new Script(`(async () => {\n${body}\n})`);
}

describe('fix generation on the demo data', () => {
  it('produces ranked fixes with an assumption, a trade-off and a dollar figure each', async () => {
    const result = analyze(await demo());
    expect(result.fixes.length).toBeGreaterThanOrEqual(10);
    for (const fix of result.fixes) {
      expect(fix.assumption.length, fix.id).toBeGreaterThan(20);
      expect(fix.youLose.length, fix.id).toBeGreaterThan(10);
      expect(fix.docs.length, fix.id).toBeGreaterThan(0);
      for (const doc of fix.docs) expect(doc.url, fix.id).toMatch(/^https:\/\/posthog\.com\/docs\//);
      expect(fix.savingUsd, fix.id).not.toBeNull();
      expect(fix.savingUsd ?? 0, fix.id).toBeGreaterThan(0);
    }
    const savings = result.fixes.map((f) => f.savingUsd ?? 0);
    expect(savings).toEqual([...savings].sort((a, b) => b - a));
    const ids = result.fixes.map((f) => f.id);
    for (const expected of [
      'flags-local-evaluation',
      'autocapture-marketing-pages',
      'person-profiles-identified-only',
      'pageleave-off',
      'identify-dedupe',
      'replay-min-duration',
      'bots-filter',
      'dev-hosts-off',
      'server-anonymous-events',
      'staging-project-21346',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('counts overlapping fixes once: combined ≤ sum of individual savings, no-regret ≤ all', async () => {
    const result = analyze(await demo());
    const sum = result.fixes.reduce((s, f) => s + (f.savingUsd ?? 0), 0);
    expect(result.savings.allUsd).toBeLessThanOrEqual(sum + 1e-6);
    expect(result.savings.noRegretUsd).toBeLessThanOrEqual(result.savings.allUsd + 1e-6);
    expect(result.savings.costAfterAllUsd).toBeCloseTo(result.costs.totalUsd - result.savings.allUsd, 6);
    expect(result.savings.allUsd).toBeLessThan(result.costs.totalUsd);
  });

  it('emits JavaScript snippets that compile', async () => {
    const result = analyze(await demo());
    const js = result.fixes.flatMap((f) => f.snippets.filter((s) => s.language === 'js').map((s) => ({ id: f.id, code: s.code })));
    expect(js.length).toBeGreaterThan(3);
    for (const { id, code } of js) expect(() => compiles(code), id).not.toThrow();
  });

  it('emits a combined posthog.init diff that is valid JavaScript once the markers are removed', async () => {
    const result = analyze(await demo());
    const diff = result.initDiff ?? '';
    expect(diff).toContain("+  person_profiles: 'identified_only',");
    expect(diff).toContain('+  capture_pageleave: false,');
    expect(diff).toContain('+    url_ignorelist: [');
    expect(diff).toContain("+  custom_blocked_useragents: ['Checkly'],");
    expect(diff).toContain('+  advanced_disable_feature_flags_on_first_load: isMarketingPage,');
    expect(diff).toMatch(/\+const isDevHost = /);
    for (const line of diff.split('\n')) expect(line === '' || /^[ +]/.test(line), line).toBe(true);
    const code = diff
      .split('\n')
      .map((l) => l.slice(1))
      .join('\n');
    expect(() => compiles(code)).not.toThrow();
    // And it really calls posthog.init with an options object we can inspect.
    let captured: Record<string, unknown> | null = null;
    const runnable = code.replace(/^import .*$/m, '');
    new Function('posthog', 'window', runnable)(
      { init: (_token: string, options: Record<string, unknown>) => (captured = options) },
      { location: { host: 'app.tidebrook.example', href: 'https://www.tidebrook.example/pricing' } },
    );
    expect(captured).not.toBeNull();
    const options = captured as unknown as Record<string, unknown>;
    expect(options.person_profiles).toBe('identified_only');
    expect(options.opt_out_capturing_by_default).toBe(false);
    expect(options.advanced_disable_feature_flags_on_first_load).toBe(true);
    const autocapture = options.autocapture as Record<string, unknown>;
    expect(autocapture.dom_event_allowlist).toEqual(['click', 'submit']);
    expect((autocapture.css_selector_ignorelist as string[]).slice(0, 2)).toEqual(['.ph-no-autocapture', '[data-ph-no-autocapture]']);
  });

  it('only uses posthog-js option names that exist in the PostHog docs', async () => {
    const documented = new Set([
      'person_profiles',
      'capture_pageleave',
      'capture_dead_clicks',
      'capture_performance',
      'custom_blocked_useragents',
      'opt_out_capturing_by_default',
      'disable_session_recording',
      'advanced_disable_flags',
      'advanced_disable_feature_flags_on_first_load',
      'autocapture.url_ignorelist',
      'autocapture.dom_event_allowlist',
      'autocapture.css_selector_ignorelist',
    ]);
    const result = analyze(await demo());
    for (const fix of result.fixes) for (const option of fix.initOptions) expect(documented.has(option.key), option.key).toBe(true);
  });
});

describe('snippet helpers', () => {
  it('quotes strings and regexes safely', () => {
    expect(jsString("it's \\ fine\n")).toBe("'it\\'s \\\\ fine\\n'");
    expect(new RegExp(escapeRegex('a.b*c/(d)')).test('a.b*c/(d)')).toBe(true);
    expect(ingestionHost('https://eu.posthog.com')).toBe('https://eu.i.posthog.com');
    expect(ingestionHost('https://us.posthog.com')).toBe('https://us.i.posthog.com');
    expect(ingestionHost('https://posthog.internal.acme.example')).toBe('https://posthog.internal.acme.example');
    expect(ingestionHost(null)).toBe('<your api_host>');
  });

  it('builds dev-host regexes that match future previews, not production', () => {
    const source = devHostRegexSource(['localhost:5173', 'shop-git-main-acme.vercel.app', 'deploy-preview-42--shop.netlify.app']) ?? '';
    const re = new RegExp(source);
    for (const host of ['localhost:5173', 'localhost:3000', 'shop-git-other-acme.vercel.app', 'deploy-preview-7--shop.netlify.app']) expect(re.test(host), host).toBe(true);
    for (const host of ['shop.example.com', 'shop.vercel.app', 'shop.netlify.app']) expect(re.test(host), host).toBe(false);
  });

  it('returns no diff when no fix touches posthog.init', () => {
    const ctx = context(snapshot());
    expect(buildInitDiff([], ctx)).toBeNull();
  });
});


describe('URL classification', () => {
  const classifier = new UrlClassifier({}, ['app.acme.example', 'www.acme.example', 'acme.example']);

  it.each([
    ['www.acme.example', '/', 'marketing'],
    ['acme.example', '/pricing', 'marketing'],
    ['acme.example', '/', 'marketing'],
    ['docs.acme.example', '/api', 'marketing'],
    ['blog.acme.example', '/post', 'marketing'],
    ['app.acme.example', '/pricing', 'app'],
    ['app.acme.example', '/', 'app'],
    ['localhost:3000', '/', 'dev'],
    ['staging.acme.example', '/', 'dev'],
    ['acme-git-main-team.vercel.app', '/', 'dev'],
    ['10.0.0.5', '/', 'dev'],
    ['shop.acme.example', '/checkout', 'unknown'],
  ])('%s%s → %s', (host, path, expected) => {
    expect(classifier.classify(host, path)).toBe(expected);
  });

  it('treats an apex domain without a separate app host as unknown unless the path is clearly marketing', () => {
    const solo = new UrlClassifier({}, ['acme.example']);
    expect(solo.classify('acme.example', '/workspace/42')).toBe('app');
    expect(solo.classify('acme.example', '/blog/hello')).toBe('marketing');
    expect(solo.classify('acme.example', '/')).toBe('unknown');
  });

  it('lets --app-url win over --marketing-url and built-in rules', () => {
    const custom = new UrlClassifier({ marketing: [/acme\.example\/(features)/], app: [/www\.acme\.example\/app/] }, []);
    expect(custom.classify('acme.example', '/features')).toBe('marketing');
    expect(custom.classify('www.acme.example', '/app/home')).toBe('app');
  });

  it('explains dev hosts and leaves real domains alone', () => {
    expect(devHostReason('localhost:8080')).toBe('localhost');
    expect(devHostReason('my-app-a1b2c3d4e-team.vercel.app')).toBe('Vercel preview deployment');
    expect(devHostReason('abc123.my-site.pages.dev')).toBe('Cloudflare Pages preview');
    expect(devHostReason('foo.ngrok-free.app')).toBe('tunnel to a dev machine');
    expect(devHostReason('app-staging.acme.example')).toBe('staging/dev subdomain');
    expect(devHostReason('developers.acme.example')).toBeNull();
    expect(devHostReason('devices.acme.example')).toBeNull();
    expect(devHostReason('acme.vercel.app')).toBeNull();
  });

  it('parses URLs loosely and collapses ids for display', () => {
    expect(parseUrlLoose('https://App.Acme.example:8443/x/y?q=1')).toEqual({ host: 'app.acme.example:8443', path: '/x/y' });
    expect(parseUrlLoose('not a url')).toBeNull();
    expect(displayPath('/reports/8812/edit')).toBe('/reports/:id/edit');
    expect(displayPath('/u/3f2a9c1e-1b2c-4d5e-8f90-123456789abc')).toBe('/u/:id');
  });
});

describe('cost model', () => {
  it('prices each meter and applies a discount to the total', () => {
    const pricing = publicPricing();
    const base = costBreakdown(usage({ events: 10_000_000, identifiedEvents: 10_000_000, recordings: 72_600, flagRequests: 11_320_000 }), pricing);
    expect(base.totalUsd).toBeCloseTo(324.4 + 755.6 + 217.7 + 493, 6);
    expect(base.lines.find((l) => l.usageKey === 'surveyResponses')?.missing).toBe('usage-unknown');
    const discounted = costBreakdown(usage({ events: 10_000_000 }), { ...pricing, table: { ...pricing.table, discountPercent: 50 } });
    expect(discounted.totalUsd).toBeCloseTo(162.2, 6);
  });

  it('applies effects as fractions of the current value and keeps identified ≤ events', () => {
    const before = usage({ events: 1_000, identifiedEvents: 900, flagRequests: 100 });
    const after = applyEffects(before, [
      { key: 'events', removeFraction: 0.5 },
      { key: 'flagRequests', removeFraction: 1, addUnits: 10 },
    ]);
    expect(after.events).toBe(500);
    expect(after.identifiedEvents).toBe(500);
    expect(after.flagRequests).toBe(10);
    expect(applyEffects(after, [{ key: 'events', removeFraction: 0.5 }]).events).toBe(250);
  });

  it('computes the marginal saving of a fix with tiers', () => {
    const pricing = publicPricing();
    const before = usage({ events: 2_000_000 });
    const after = usage({ events: 1_000_000 });
    expect(savingBetween(before, after, pricing).savingUsd).toBeCloseTo(50, 6);
    expect(savingBetween(before, before, pricing).savingUsd).toBeNull();
  });

  it('rounds billing limits to tidy numbers', () => {
    expect(niceLimit(0)).toBe(0);
    expect(niceLimit(42)).toBe(50);
    expect(niceLimit(101)).toBe(150);
    expect(niceLimit(1_201)).toBe(1_250);
    expect(niceLimit(10_001)).toBe(11_000);
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeAutocapture } from '../src/analysis/analyzers/autocapture.js';
import { analyzeBots } from '../src/analysis/analyzers/bots.js';
import { analyzeDevHosts } from '../src/analysis/analyzers/dev-hosts.js';
import { analyzeTopEvents } from '../src/analysis/analyzers/events.js';
import { analyzeFlags } from '../src/analysis/analyzers/flags.js';
import { analyzeIdentity } from '../src/analysis/analyzers/identity.js';
import { analyzeOtherProducts } from '../src/analysis/analyzers/other-products.js';
import { analyzePageviews } from '../src/analysis/analyzers/pageviews.js';
import { analyzePersonProfiles } from '../src/analysis/analyzers/person-profiles.js';
import { analyzeReplay } from '../src/analysis/analyzers/replay.js';
import { SYSTEM_EVENT_NAME, analyzeServerEvents } from '../src/analysis/analyzers/server-events.js';
import { analyzeStaging } from '../src/analysis/analyzers/staging.js';
import { applyEffects } from '../src/analysis/costs.js';
import type { Fix } from '../src/analysis/model.js';
import { context, evaluate, events, project, run, snapshot, usage } from './helpers.js';

const fix = (fixes: Fix[], id: string): Fix => {
  const found = fixes.find((f) => f.id === id);
  if (!found) throw new Error(`expected fix ${id}, got ${fixes.map((f) => f.id).join(', ') || 'none'}`);
  return found;
};
const effect = (f: Fix, key: string) => f.effects.find((e) => e.key === key)?.removeFraction ?? 0;

describe('top events', () => {
  const snap = snapshot({
    events: events({
      byEvent: [
        { event: '$autocapture', count: 400_000, identified: 0 },
        { event: 'api_request', count: 300_000, identified: 300_000 },
        { event: '$web_vitals', count: 150_000, identified: 0 },
        { event: '$dead_click', count: 50_000, identified: 0 },
        { event: 'signup', count: 100_000, identified: 50_000 },
        { event: '$feature_flag_called', count: 500_000, identified: 0 },
        { event: '$exception', count: 20_000, identified: 0 },
      ],
      totals: { billable: 1_000_000, billableIdentified: 350_000 },
    }),
  });

  it('ranks events by their share of the bill and leaves owned events to their analyzers', () => {
    const out = run(analyzeTopEvents, snap);
    const ids = out.drivers.map((d) => d.id);
    expect(ids).toContain('event:api_request');
    expect(ids).not.toContain('event:$autocapture');
    expect(ids).not.toContain('event:$feature_flag_called');
    expect(ids[0]).toBe('event:api_request'); // identified events cost more per event
  });

  it('explains which events are not billed as analytics events', () => {
    const out = run(analyzeTopEvents, snap);
    const text = out.findings.map((f) => f.text).join(' ');
    expect(text).toMatch(/\$feature_flag_called \(flags are billed per \/flags request instead\)/);
    expect(text).toMatch(/\$exception \(billed under Error tracking\)/);
  });

  it('suggests turning off dead clicks and web vitals when they are a real share', () => {
    const out = run(analyzeTopEvents, snap);
    const extras = fix(out.fixes, 'autocapture-extras');
    expect(extras.kind).toBe('trade-off');
    expect(effect(extras, 'events')).toBeCloseTo(200_000 / 1_000_000, 6);
    expect(extras.initOptions.map((o) => `${o.key}: ${o.value}`)).toEqual(['capture_dead_clicks: false', 'capture_performance: { web_vitals: false }']);
  });

  it('reports a gap instead of guessing when there is no event data', () => {
    expect(run(analyzeTopEvents, snapshot()).notAnalyzed[0]).toMatch(/no per-event counts/);
  });
});

describe('autocapture', () => {
  const base = () =>
    snapshot({
      events: events({
        byEvent: [{ event: '$autocapture', count: 1_000_000, identified: 500_000 }],
        totals: { billable: 2_000_000, billableIdentified: 800_000 },
        byHost: [
          { host: 'app.acme.example', count: 1_200_000, identified: 700_000 },
          { host: 'www.acme.example', count: 800_000, identified: 100_000 },
        ],
        byPage: [
          { host: 'www.acme.example', path: '/', count: 600_000, identified: 0, unidentifiedPersonEvents: 0, pageviews: 100_000, pageleaves: 0, autocapture: 300_000 },
          { host: 'www.acme.example', path: '/pricing', count: 200_000, identified: 100_000, unidentifiedPersonEvents: 0, pageviews: 50_000, pageleaves: 0, autocapture: 100_000 },
          { host: 'app.acme.example', path: '/dashboard', count: 1_200_000, identified: 700_000, unidentifiedPersonEvents: 0, pageviews: 100_000, pageleaves: 0, autocapture: 600_000 },
        ],
        autocaptureDomEvents: [
          { domEvent: 'click', host: 'app.acme.example', count: 480_000 },
          { domEvent: 'change', host: 'app.acme.example', count: 120_000 },
          { domEvent: 'click', host: 'www.acme.example', count: 400_000 },
        ],
        autocaptureElements: [
          { host: 'www.acme.example', domEvent: 'click', tag: 'button', classes: '.carousel__next', text: 'Next', count: 250_000, sessions: 25_000 },
          { host: 'app.acme.example', domEvent: 'click', tag: 'button', classes: '.grid-cell.cell', text: '42', count: 200_000, sessions: 20_000 },
          { host: 'app.acme.example', domEvent: 'click', tag: 'button', classes: '.btn', text: 'Upgrade now', count: 90_000, sessions: 9_000 },
          { host: 'app.acme.example', domEvent: 'click', tag: 'a', classes: '.nav', text: 'Home', count: 60_000, sessions: 40_000 },
          { host: 'app.acme.example', domEvent: 'click', tag: 'button', classes: null, text: null, count: 40_000, sessions: 5_000 },
        ],
      }),
    });

  it('ignores autocapture on marketing pages with a url_ignorelist built from the data', () => {
    const out = run(analyzeAutocapture, base());
    const f = fix(out.fixes, 'autocapture-marketing-pages');
    expect(effect(f, 'events')).toBeCloseTo(400_000 / 2_000_000, 6);
    expect(effect(f, 'identifiedEvents')).toBeCloseTo((300_000 * 0 + 100_000 * 0.5) / 800_000, 6);
    const value = f.initOptions[0]?.value ?? '';
    expect(f.initOptions[0]?.key).toBe('autocapture.url_ignorelist');
    // The generated literal must be valid JavaScript and match only marketing URLs.
    const re = evaluate<RegExp[]>(`(${value})`);
    expect(re.some((r) => r.test('https://www.acme.example/pricing'))).toBe(true);
    expect(re.some((r) => r.test('https://app.acme.example/dashboard'))).toBe(false);
  });

  it('drops autocaptured change events when they are a big share', () => {
    const out = run(analyzeAutocapture, base());
    const f = fix(out.fixes, 'autocapture-dom-events');
    expect(effect(f, 'events')).toBeCloseTo(120_000 / 2_000_000, 6);
    expect(f.initOptions[0]).toMatchObject({ key: 'autocapture.dom_event_allowlist', value: "['click', 'submit']" });
  });

  it('ignores the noisiest app elements but never conversion buttons or marketing elements', () => {
    const out = run(analyzeAutocapture, base());
    const f = fix(out.fixes, 'autocapture-noisy-elements');
    const value = f.initOptions[0]?.value ?? '';
    expect(value).toContain("'.grid-cell'");
    expect(value).toContain("'.ph-no-autocapture'");
    expect(value).toContain("'[data-ph-no-autocapture]'");
    expect(value).not.toContain('carousel'); // marketing: covered by the URL fix
    expect(value).not.toContain('.btn'); // "Upgrade now" looks like a conversion
    expect(f.steps.join(' ')).toMatch(/ph-no-autocapture/); // the element without classes
    expect(effect(f, 'events')).toBeCloseTo((200_000 + 40_000) / 2_000_000, 6);
  });

  it('produces no fixes when autocapture is small and spread out', () => {
    const snap = snapshot({
      events: events({
        byEvent: [{ event: '$autocapture', count: 10_000, identified: 0 }],
        totals: { billable: 1_000_000 },
        byPage: [{ host: 'app.acme.example', path: '/', count: 1_000_000, identified: 0, unidentifiedPersonEvents: 0, pageviews: 0, pageleaves: 0, autocapture: 10_000 }],
      }),
    });
    const out = run(analyzeAutocapture, snap);
    expect(out.fixes).toEqual([]);
    expect(out.drivers).toHaveLength(1);
  });

  it('warns when autocapture is off in settings but events still arrive', () => {
    const snap = base();
    snap.projectSettings = {
      autocaptureOptOut: true,
      sessionRecordingOptIn: null,
      sessionRecordingSampleRate: null,
      sessionRecordingMinimumDurationMs: null,
      sessionRecordingUrlTriggerCount: null,
      sessionRecordingTriggerGroupCount: null,
      heatmapsOptIn: null,
      captureDeadClicks: null,
    };
    expect(run(analyzeAutocapture, snap).findings[0]?.level).toBe('warning');
  });
});

describe('pageviews and pageleaves', () => {
  it('offers capture_pageleave: false with the bounce-rate trade-off', () => {
    const snap = snapshot({
      events: events({
        byEvent: [
          { event: '$pageview', count: 300_000, identified: 0 },
          { event: '$pageleave', count: 250_000, identified: 50_000 },
        ],
        totals: { billable: 1_000_000, billableIdentified: 100_000 },
      }),
    });
    const out = run(analyzePageviews, snap);
    const f = fix(out.fixes, 'pageleave-off');
    expect(f.youLose).toMatch(/bounce rate/i);
    expect(effect(f, 'events')).toBeCloseTo(0.25, 6);
    expect(effect(f, 'identifiedEvents')).toBeCloseTo(0.5, 6);
    expect(out.drivers.map((d) => d.id)).toEqual(['event:$pageview', 'event:$pageleave']);
  });

  it('skips the fix when pageleaves are a tiny share', () => {
    const snap = snapshot({ events: events({ byEvent: [{ event: '$pageleave', count: 10_000, identified: 0 }], totals: { billable: 1_000_000 } }) });
    expect(run(analyzePageviews, snap).fixes).toEqual([]);
  });
});

describe('identify / $set / group duplicates', () => {
  const snap = snapshot({
    events: events({
      byEvent: [
        { event: '$identify', count: 200_000, identified: 200_000 },
        { event: '$groupidentify', count: 100_000, identified: 100_000 },
      ],
      totals: { billable: 2_000_000, billableIdentified: 1_000_000 },
      identity: [
        { event: '$identify', lib: 'posthog-node', count: 150_000, necessary: 20_000 },
        { event: '$identify', lib: 'web', count: 50_000, necessary: 45_000 },
        { event: '$groupidentify', lib: 'web', count: 100_000, necessary: 30_000 },
      ],
    }),
  });

  it('counts repeats beyond one per session/user-day as avoidable', () => {
    const out = run(analyzeIdentity, snap);
    const f = fix(out.fixes, 'identify-dedupe');
    const avoidable = 130_000 + 5_000 + 70_000;
    expect(f.kind).toBe('no-regret');
    expect(effect(f, 'events')).toBeCloseTo(avoidable / 2_000_000, 6);
    expect(effect(f, 'identifiedEvents')).toBeCloseTo(avoidable / 1_000_000, 6);
    expect(f.snippets.map((s) => s.title).join(' ')).toMatch(/posthog-js/);
    expect(f.snippets.map((s) => s.title).join(' ')).toMatch(/posthog-node/);
  });

  it('says what is missing when there is no per-session breakdown', () => {
    const s = snapshot({ events: events({ byEvent: [{ event: '$identify', count: 5, identified: 5 }], totals: { billable: 100 } }) });
    expect(run(analyzeIdentity, s).notAnalyzed[0]).toMatch(/no per-session breakdown/);
  });
});

describe('person profiles for anonymous visitors', () => {
  it("converts identified events from never-identified visitors to anonymous (events unchanged)", () => {
    const snap = snapshot({
      events: events({
        byEvent: [{ event: '$pageview', count: 1_000_000, identified: 800_000 }],
        totals: { billable: 3_000_000, billableIdentified: 2_000_000, unidentifiedPersonEvents: 900_000 },
        byPage: [
          { host: 'www.acme.example', path: '/', count: 1_000_000, identified: 800_000, unidentifiedPersonEvents: 750_000, pageviews: 0, pageleaves: 0, autocapture: 0 },
          { host: 'app.acme.example', path: '/home', count: 500_000, identified: 500_000, unidentifiedPersonEvents: 150_000, pageviews: 0, pageleaves: 0, autocapture: 0 },
        ],
      }),
    });
    const ctx = context(snap);
    const out = analyzePersonProfiles(ctx);
    const f = fix(out.fixes, 'person-profiles-identified-only');
    expect(f.effects).toEqual([{ key: 'identifiedEvents', removeFraction: 900_000 / 2_000_000 }]);
    expect(f.initOptions[0]).toMatchObject({ key: 'person_profiles', value: "'identified_only'" });
    const after = applyEffects(ctx.org, f.effects);
    expect(after.events).toBe(ctx.org.events);
    expect(after.identifiedEvents).toBeCloseTo(1_100_000, 3);
    expect(f.evidence).toMatch(/83% of them on marketing pages/);
  });

  it('notes the gap when the snapshot lacks the $is_identified split', () => {
    const snap = snapshot({ events: events({ byEvent: [], totals: { billable: 10, billableIdentified: 5 } }) });
    expect(run(analyzePersonProfiles, snap).notAnalyzed[0]).toMatch(/\$is_identified/);
  });
});

describe('server-side events', () => {
  it('recognizes bookkeeping event names', () => {
    for (const name of ['api_request', 'sync_job_completed', 'webhook_received', 'cron.run', 'health-check ping']) expect(SYSTEM_EVENT_NAME.test(name), name).toBe(true);
    for (const name of ['report_exported', 'invoice_paid', 'signup_completed', 'jobsite_viewed']) expect(SYSTEM_EVENT_NAME.test(name), name).toBe(false);
  });

  it('suggests anonymous capture with a non-person distinct ID for those events only', () => {
    const snap = snapshot({
      events: events({
        byEvent: [],
        totals: { billable: 2_000_000, billableIdentified: 1_500_000 },
        serverEvents: [
          { lib: 'posthog-node', event: 'api_request', count: 600_000, identified: 600_000 },
          { lib: 'posthog-node', event: 'invoice_paid', count: 5_000, identified: 5_000 },
          { lib: 'posthog-python', event: 'sync_job_completed', count: 100_000, identified: 100_000 },
          { lib: 'posthog-node', event: '$pageview', count: 50_000, identified: 50_000 },
        ],
      }),
    });
    const out = run(analyzeServerEvents, snap);
    const f = fix(out.fixes, 'server-anonymous-events');
    expect(f.effects).toEqual([{ key: 'identifiedEvents', removeFraction: 700_000 / 1_500_000 }]);
    const code = f.snippets[0]?.code ?? '';
    expect(code).toMatch(/process_person_profile: false/);
    expect(code).toMatch(/randomUUID\(\)/);
    expect(out.drivers[0]?.units).toBeCloseTo(705_000, 3); // $pageview is left to the bots analyzer
  });
});

describe('bots', () => {
  const snap = snapshot({
    events: events({
      byEvent: [],
      totals: { billable: 1_000_000, billableIdentified: 0 },
      bots: [
        { userAgent: 'Mozilla/5.0 (X11) Chrome/131 Safari/537.36 Checkly/2.4', lib: 'web', count: 40_000, identified: 40_000 },
        { userAgent: 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', lib: 'posthog-node', count: 10_000, identified: 10_000 },
      ],
    }),
  });

  it('blocks web bots via custom_blocked_useragents and server bots before capture()', () => {
    const out = run(analyzeBots, snap);
    const f = fix(out.fixes, 'bots-filter');
    expect(f.kind).toBe('no-regret');
    expect(effect(f, 'events')).toBeCloseTo(0.05, 6);
    expect(f.initOptions[0]).toMatchObject({ key: 'custom_blocked_useragents', value: "['Checkly']" });
    const server = f.snippets[0]?.code ?? '';
    expect(server).toMatch(/AhrefsBot/);
    const re = evaluate<RegExp>(`${server.split('\n')[0]}; BOT_UA`);
    expect(re.test('Mozilla/5.0 (compatible; AhrefsBot/7.0)')).toBe(true);
    expect(re.test('Mozilla/5.0 (Macintosh) Safari/605.1.15')).toBe(false);
  });

  it('reports the gap when there is no user-agent data', () => {
    expect(run(analyzeBots, snapshot({ events: events({ byEvent: [] }) })).notAnalyzed[0]).toMatch(/user-agent/);
  });
});

describe('local, preview and staging hosts', () => {
  const snap = snapshot({
    events: events({
      byEvent: [],
      totals: { billable: 1_000_000, billableIdentified: 0 },
      byHost: [
        { host: 'app.acme.example', count: 800_000, identified: 0 },
        { host: 'localhost:3000', count: 50_000, identified: 0 },
        { host: 'acme-git-fix-login-acme.vercel.app', count: 30_000, identified: 0 },
        { host: 'staging.acme.example', count: 20_000, identified: 0 },
        { host: '192.168.1.20:8080', count: 1_000, identified: 0 },
      ],
    }),
    replay: { recordings: 1_000, durations: null, activeUnder5s: null, byFirstUrl: [{ url: 'http://localhost:3000/', count: 100, under5s: 0, singleUrl: null }] },
  });

  it('drops them with isDevHost guards that match exactly the dev hosts', () => {
    const out = run(analyzeDevHosts, snap);
    const f = fix(out.fixes, 'dev-hosts-off');
    expect(effect(f, 'events')).toBeCloseTo(101_000 / 1_000_000, 6);
    expect(effect(f, 'recordings')).toBeCloseTo(0.1, 6);
    const preamble = f.initOptions[0]?.preamble?.[0] ?? '';
    const isDevHost = (host: string) => evaluate<boolean>(`${preamble}; isDevHost`, { window: { location: { host } } });
    for (const host of ['localhost:3000', 'localhost', 'acme-git-other-branch-acme.vercel.app', 'staging.acme.example', '192.168.1.20:8080']) {
      expect(isDevHost(host), host).toBe(true);
    }
    for (const host of ['app.acme.example', 'www.acme.example', 'acme.vercel.app']) expect(isDevHost(host), host).toBe(false);
    expect(f.initOptions.map((o) => o.key)).toEqual(['opt_out_capturing_by_default', 'disable_session_recording', 'advanced_disable_flags']);
  });

  it('respects --dev-host patterns', () => {
    const s = snapshot({ events: events({ byEvent: [], totals: { billable: 100 }, byHost: [{ host: 'box7.acme-internal.example', count: 10, identified: 0 }] }) });
    expect(run(analyzeDevHosts, s).fixes).toEqual([]);
    expect(run(analyzeDevHosts, s, { devHostPatterns: [/^box7\./] }).fixes).toHaveLength(1);
  });
});

describe('other projects sharing the allowance', () => {
  const snap = snapshot({
    events: events({ byEvent: [], totals: { billable: 5_000_000, billableIdentified: 0 } }),
    orgUsage: [
      project('1', { events: 5_000_000, identifiedEvents: 0, flagRequests: 1_000_000 }, { audited: true, name: 'Prod' }),
      project('2', { events: 2_000_000, identifiedEvents: 0, flagRequests: 3_000_000 }, { name: 'Acme Staging' }),
      project('3', { events: 500_000, identifiedEvents: 0 }, { name: 'Marketing site' }),
    ],
  });

  it('offers a trade-off fix for staging-like projects and only reports the others', () => {
    const out = run(analyzeStaging, snap);
    const f = fix(out.fixes, 'staging-project-2');
    expect(f.kind).toBe('trade-off');
    expect(effect(f, 'events')).toBeCloseTo(2_000_000 / 7_500_000, 6);
    expect(effect(f, 'flagRequests')).toBeCloseTo(3_000_000 / 4_000_000, 6);
    expect(out.fixes).toHaveLength(1);
    expect(out.findings[0]?.text).toMatch(/Marketing site/);
    expect(out.drivers[0]?.costUsd).toBeGreaterThan(0);
  });

  it('needs organization usage', () => {
    expect(run(analyzeStaging, snapshot()).notAnalyzed[0]).toMatch(/billing:read/);
  });
});

describe('session replay', () => {
  const replaySnap = (settings: Partial<NonNullable<ReturnType<typeof snapshot>['projectSettings']>> = {}) =>
    snapshot({
      events: events({
        byEvent: [],
        totals: { billable: 100 },
        byHost: [
          { host: 'app.acme.example', count: 50, identified: 0 },
          { host: 'www.acme.example', count: 50, identified: 0 },
        ],
      }),
      replay: {
        recordings: 100_000,
        durations: { under5s: 30_000, under10s: 40_000, under30s: 50_000, under60s: 60_000 },
        activeUnder5s: 45_000,
        byFirstUrl: [
          { url: 'https://www.acme.example/', count: 40_000, under5s: 20_000, singleUrl: 25_000 },
          { url: 'https://app.acme.example/home', count: 60_000, under5s: 10_000, singleUrl: 5_000 },
        ],
      },
      projectSettings: {
        autocaptureOptOut: null,
        sessionRecordingOptIn: true,
        sessionRecordingSampleRate: null,
        sessionRecordingMinimumDurationMs: null,
        sessionRecordingUrlTriggerCount: 0,
        sessionRecordingTriggerGroupCount: 0,
        heatmapsOptIn: null,
        captureDeadClicks: null,
        ...settings,
      },
    });

  it('suggests a 5s minimum duration, app-only URL triggers and sampling', () => {
    const out = run(analyzeReplay, replaySnap());
    expect(effect(fix(out.fixes, 'replay-min-duration'), 'recordings')).toBeCloseTo(0.3, 6);
    const appOnly = fix(out.fixes, 'replay-app-only');
    expect(effect(appOnly, 'recordings')).toBeCloseTo(0.25, 6); // only single-page marketing sessions
    expect(appOnly.steps[0]).toMatch(/app\\\.acme\\\.example/);
    expect(effect(fix(out.fixes, 'replay-sampling'), 'recordings')).toBeCloseTo(0.5, 6);
    expect(out.drivers.map((d) => d.id)).toEqual(['replay:all', 'replay:short', 'replay:marketing']);
  });

  it('respects settings that are already in place', () => {
    const out = run(analyzeReplay, replaySnap({ sessionRecordingMinimumDurationMs: 5000, sessionRecordingSampleRate: 0.2 }));
    expect(out.fixes.map((f) => f.id)).toEqual(['replay-app-only']);
  });

  it('uses the upper bound (and says so) when single-page counts are unknown', () => {
    const snap = replaySnap();
    for (const r of snap.replay?.byFirstUrl ?? []) r.singleUrl = null;
    const f = fix(run(analyzeReplay, snap).fixes, 'replay-app-only');
    expect(f.assumption).toMatch(/upper bound/);
    expect(effect(f, 'recordings')).toBeCloseTo(0.4, 6);
  });
});

describe('feature flags', () => {
  const flagsSnap = (locallyEvaluated: 'true' | 'false') =>
    snapshot({
      events: events({
        byEvent: [{ event: '$pageview', count: 1_000_000, identified: 0 }],
        totals: { billable: 1_000_000 },
        byPage: [{ host: 'www.acme.example', path: '/', count: 400_000, identified: 0, unidentifiedPersonEvents: 0, pageviews: 400_000, pageleaves: 0, autocapture: 0 },
          { host: 'app.acme.example', path: '/home', count: 600_000, identified: 0, unidentifiedPersonEvents: 0, pageviews: 600_000, pageleaves: 0, autocapture: 0 }],
      }),
      orgUsage: [project('1', { flagRequests: 10_000_000 }, { audited: true })],
      flags: {
        definitions: [
          { key: 'a', active: true, ensureExperienceContinuity: true, usesStaticCohort: false, usesIsNotSet: false, evaluationRuntime: null, lastCalledAt: '2026-11-17T00:00:00Z' },
          { key: 'old', active: true, ensureExperienceContinuity: false, usesStaticCohort: false, usesIsNotSet: false, evaluationRuntime: null, lastCalledAt: '2026-01-01T00:00:00Z' },
        ],
        calledByLib: [{ lib: 'posthog-node', locallyEvaluated, count: 200_000, flags: 3 }],
      },
    });

  it('moves server-side checks to local evaluation and adds back the polling cost', () => {
    const out = run(analyzeFlags, flagsSnap('false'), { serverInstances: 2 });
    const f = fix(out.fixes, 'flags-local-evaluation');
    expect(f.kind).toBe('no-regret');
    expect(f.effects[0]).toEqual({ key: 'flagRequests', removeFraction: 0.9, addUnits: 2 * 86_400 });
    expect(f.assumption).toMatch(/1 flag\(s\) can't be evaluated locally/);
    expect(f.snippets[0]?.code).toMatch(/featureFlagsPollingInterval/);
    expect(out.findings.map((x) => x.text).join(' ')).toMatch(/weren't called in the last 30 days \(old\)/);
  });

  it('suggests a longer polling interval when servers already evaluate locally', () => {
    const out = run(analyzeFlags, flagsSnap('true'));
    expect(out.fixes.map((f) => f.id)).toContain('flags-polling-interval');
    expect(out.fixes.map((f) => f.id)).not.toContain('flags-local-evaluation');
  });

  it('skips flag evaluation on marketing page loads', () => {
    const f = fix(run(analyzeFlags, flagsSnap('false')).fixes, 'flags-marketing-first-load');
    expect(f.effects[0]?.removeFraction).toBeCloseTo(0.04, 6);
    expect(f.initOptions[0]).toMatchObject({ key: 'advanced_disable_feature_flags_on_first_load', value: 'isMarketingPage' });
    expect(f.initOptions[0]?.preamble?.[0]).toMatch(/const isMarketingPage = /);
  });

  it('does not guess request volume without billing data', () => {
    const snap = flagsSnap('false');
    snap.orgUsage = null;
    const out = run(analyzeFlags, snap);
    expect(out.fixes).toEqual([]);
    expect(out.notAnalyzed[0]).toMatch(/billing:read/);
  });
});

describe('other products', () => {
  it('adds survey and exception lines and always lists what is not estimated', () => {
    const snap = snapshot({ orgUsage: [project('1', { surveyResponses: 2_500, exceptions: 400_000 }, { audited: true })] });
    const out = run(analyzeOtherProducts, snap);
    expect(out.drivers.map((d) => d.id)).toEqual(['surveys', 'exceptions']);
    expect(out.drivers[0]?.costUsd).toBeCloseTo(67.5, 6);
    expect(out.findings[0]?.text).toMatch(/suppression rules/);
    expect(out.notAnalyzed[0]).toMatch(/group analytics/);
  });
});

describe('usage resolution', () => {
  it('normalizes a 7-day window to a 30-day month', () => {
    const snap = snapshot({ period: { days: 7, start: null, end: null }, events: events({ byEvent: [], totals: { billable: 700_000 } }) });
    expect(context(snap).org.events).toBeCloseTo(3_000_000, 6);
  });

  it('adds other projects to organization totals but keeps project numbers separate', () => {
    const snap = snapshot({
      events: events({ byEvent: [], totals: { billable: 1_000_000, billableIdentified: 100_000 } }),
      orgUsage: [project('1', { events: 1_000_000 }, { audited: true }), project('2', { events: 3_000_000, identifiedEvents: 50_000 })],
    });
    const ctx = context(snap);
    expect(ctx.scope).toBe('organization');
    expect(ctx.project.events).toBe(1_000_000);
    expect(ctx.org.events).toBe(4_000_000);
    expect(ctx.project.identifiedEvents).toBe(100_000); // falls back to HogQL when billing lacks it
    expect(ctx.org.identifiedEvents).toBe(150_000);
  });

  it('allocates identified events the person-profile rate on top of the event rate', () => {
    const snap = snapshot({ events: events({ byEvent: [], totals: { billable: 10_000_000, billableIdentified: 10_000_000 } }) });
    const ctx = context(snap);
    expect(ctx.allocateEvents(10_000_000, 10_000_000)).toBeCloseTo(1080, 6);
    expect(ctx.allocateEvents(10_000_000, 0)).toBeCloseTo(324.4, 6);
    expect(usage({ events: 1 }).recordings).toBeNull();
  });
});

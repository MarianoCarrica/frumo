import { DOCS, WEB_LIB, isServerLib } from '../../posthog-facts.js';
import { count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, Fix, Snippet } from '../model.js';
import { eventTitle } from './events.js';

const IDENTITY_EVENTS = ['$identify', '$set', '$groupidentify', '$create_alias'] as const;

/** Repeated $identify / $set / $groupidentify calls. */
export function analyzeIdentity(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const events = ctx.snap.events;
  if (!events) return out;
  const projectEvents = ctx.project.events;

  const drivers = new Map<string, Driver>();
  for (const name of IDENTITY_EVENTS) {
    const e = events.byEvent.find((row) => row.event === name);
    if (!e || e.count <= 0) continue;
    const units = ctx.monthlyEvents(e.count);
    // These calls create or update person profiles, so they are identified events.
    const identified = ctx.monthlyIdentified(e.identified ?? e.count);
    const driver: Driver = {
      id: `event:${name}`,
      title: eventTitle(name),
      product: 'product_analytics',
      units,
      unitLabel: 'events',
      costUsd: ctx.allocateEvents(units, identified),
      shareOfProduct: projectEvents ? units / projectEvents : null,
      detail: `${count(units)} events/mo (${pct(projectEvents ? units / projectEvents : null)} of this project's events).`,
      evidence: [],
      fixIds: [],
    };
    drivers.set(name, driver);
    out.drivers.push(driver);
  }

  const rows = events.identity ?? [];
  if (rows.length === 0) {
    if (drivers.size > 0) out.notAnalyzed.push('Duplicate identify/group calls: no per-session breakdown in the snapshot.');
    return out;
  }

  let avoidable = 0;
  const evidenceRows: Array<Array<string | number>> = [];
  const libs = new Set<string>();
  for (const row of [...rows].sort((a, b) => b.count - a.count)) {
    const repeats = Math.max(0, row.count - row.necessary);
    avoidable += repeats;
    if (repeats > 0 && row.lib) libs.add(row.lib);
    evidenceRows.push([
      row.event,
      row.lib ?? '(unknown)',
      count(ctx.monthlyEvents(row.count)),
      count(ctx.monthlyEvents(row.necessary)),
      count(ctx.monthlyEvents(repeats)),
    ]);
  }
  const evidence = {
    title: 'Identity calls vs. what is needed',
    columns: ['Event', 'SDK', 'Calls/mo', 'Needed/mo', 'Repeats/mo'],
    rows: evidenceRows.slice(0, 10),
    note: 'Needed = distinct (session, user, day, group) combinations.',
  };
  for (const d of drivers.values()) d.evidence.push(evidence);

  const monthlyAvoidable = ctx.monthlyEvents(avoidable);
  if (avoidable <= 0 || !projectEvents || (monthlyAvoidable / projectEvents < 0.01 && monthlyAvoidable < 20_000)) return out;

  const snippets: Snippet[] = [];
  if (libs.has(WEB_LIB) || libs.size === 0) snippets.push(webSnippet());
  const serverLib = [...libs].find((l) => isServerLib(l));
  if (serverLib) snippets.push(serverSnippet(serverLib));

  const fix: Fix = {
    id: 'identify-dedupe',
    title: 'Stop repeating identify(), $set and group() calls',
    kind: 'no-regret',
    products: ['product_analytics', 'identified_events'],
    effects: [
      { key: 'events', removeFraction: fractionOf(monthlyAvoidable, ctx.org.events) },
      { key: 'identifiedEvents', removeFraction: fractionOf(ctx.monthlyIdentified(avoidable), ctx.org.identifiedEvents) },
    ],
    assumption: `One $identify / $set / $groupidentify per session (browser) or per user per day (server SDKs) is enough; the ${count(monthlyAvoidable)}/mo repeats beyond that are treated as avoidable.`,
    youLose: 'Nothing, as long as you still identify on signup/login and when person or group properties change.',
    steps: [
      'Calling identify() again with the same ID does not create another $identify event, but every call with changed properties sends a $set event (PostHog docs).',
      'Call group() once per session, not on every route change.',
    ],
    snippets,
    initOptions: [],
    docs: [
      { title: 'Only call identify() once per session', url: `${DOCS.analyticsCuttingCosts}#only-call-identify-once-per-session` },
      { title: 'Only call group() once per session', url: `${DOCS.analyticsCuttingCosts}#only-call-group-once-per-session` },
    ],
    evidence: `${count(monthlyAvoidable)} repeated identity calls/mo (${[...libs].join(', ') || 'unknown SDK'}).`,
  };
  out.fixes.push(fix);
  for (const d of drivers.values()) d.fixIds.push(fix.id);
  return out;
}

function webSnippet(): Snippet {
  return {
    title: 'Browser (posthog-js): identify once after login, group once per session',
    language: 'js',
    code: [
      '// Run after login/signup, not on every page load or route change.',
      'if (posthog.get_distinct_id() !== user.id) {',
      '  posthog.identify(user.id, { email: user.email, plan: user.plan })',
      '}',
      '',
      '// group(): once per session',
      'const groupFlag = `ph_grouped_${user.companyId}`',
      'if (!sessionStorage.getItem(groupFlag)) {',
      "  posthog.group('company', user.companyId, { name: user.companyName })",
      "  sessionStorage.setItem(groupFlag, '1')",
      '}',
    ].join('\n'),
  };
}

function serverSnippet(lib: string): Snippet {
  if (lib === 'posthog-python') {
    return {
      title: 'Server (posthog-python): identify on signup/login or property changes, not per request',
      language: 'python',
      code: [
        '# Before: middleware that identifies on every request',
        '#   posthog.identify(request.user.id, {"plan": request.user.plan})',
        '',
        '# After: only where person properties actually change',
        'def on_plan_changed(user):',
        '    posthog.set(distinct_id=user.id, properties={"plan": user.plan})',
      ].join('\n'),
    };
  }
  return {
    title: `Server (${lib}): identify on signup/login or property changes, not per request`,
    language: 'js',
    code: [
      '// Before: middleware that identifies on every request',
      '//   app.use((req, res, next) => { posthog.identify({ distinctId: req.user.id, properties: { plan: req.user.plan } }); next() })',
      '',
      '// After: only where person properties actually change (signup, login, plan change)',
      'export function onPlanChanged(user) {',
      '  posthog.identify({ distinctId: user.id, properties: { plan: user.plan } })',
      '}',
    ].join('\n'),
  };
}

import { DOCS, NON_BILLABLE_EVENT_PREFIX, isBillableEvent, isServerLib } from '../../posthog-facts.js';
import { count, pct, usd } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, Fix } from '../model.js';

/** Events with a dedicated analyzer (they get richer drivers there). */
export const OWNED_EVENTS: ReadonlySet<string> = new Set([
  '$autocapture',
  '$pageview',
  '$pageleave',
  '$identify',
  '$set',
  '$groupidentify',
  '$create_alias',
]);

const DESCRIPTIONS: Record<string, string> = {
  $web_vitals: 'Web vitals performance events',
  $dead_click: 'dead clicks (clicks that change nothing)',
  $rageclick: 'rage clicks',
  $copy_autocapture: 'copied text (autocapture)',
  $screen: 'mobile screen views',
  $groupidentify: 'group() calls',
};

export function eventTitle(event: string): string {
  const description = DESCRIPTIONS[event];
  return description ? `${event} (${description})` : `"${event}" events`;
}

/** Top events by share of the bill (except the ones other analyzers own), plus a few event-level fixes. */
export function analyzeTopEvents(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const events = ctx.snap.events;
  if (!events || events.byEvent.length === 0) {
    out.notAnalyzed.push('Product analytics events: the snapshot has no per-event counts.');
    return out;
  }
  const share = ctx.identifiedShare();
  const projectEvents = ctx.project.events;
  const serverLibsByEvent = new Map<string, string>();
  for (const row of events.serverEvents ?? []) {
    if (!serverLibsByEvent.has(row.event) && isServerLib(row.lib)) serverLibsByEvent.set(row.event, row.lib);
  }

  const drivers: Driver[] = events.byEvent
    .filter((e) => e.count > 0 && isBillableEvent(e.event) && !OWNED_EVENTS.has(e.event))
    .map((e) => {
      const units = ctx.monthlyEvents(e.count);
      const identifiedWindow = e.identified ?? e.count * share;
      const identified = ctx.monthlyIdentified(identifiedWindow);
      const lib = serverLibsByEvent.get(e.event);
      const parts = [
        `${count(units)} events/mo (${pct(projectEvents ? units / projectEvents : null)} of this project's events)`,
        `${pct(e.count > 0 ? identifiedWindow / e.count : 0)} identified${e.identified === null ? ' (estimated)' : ''}`,
      ];
      if (lib) parts.push(`sent from ${lib}`);
      return {
        id: `event:${e.event}`,
        title: eventTitle(e.event),
        product: 'product_analytics' as const,
        units,
        unitLabel: 'events',
        costUsd: ctx.allocateEvents(units, identified),
        shareOfProduct: projectEvents ? units / projectEvents : null,
        detail: `${parts.join(', ')}.`,
        evidence: [],
        fixIds: [],
      };
    })
    .sort((a, b) => (b.costUsd ?? b.units) - (a.costUsd ?? a.units))
    .slice(0, 8);
  out.drivers.push(...drivers);

  const extras = extrasFix(ctx);
  if (extras) {
    out.fixes.push(extras);
    for (const d of out.drivers) if (d.id === 'event:$web_vitals' || d.id === 'event:$dead_click') d.fixIds.push(extras.id);
  }

  const nonBillable = events.byEvent.filter((e) => e.count > 0 && !isBillableEvent(e.event)).slice(0, 5);
  if (nonBillable.length > 0) {
    const list = nonBillable.map((e) => `${count(ctx.monthly(e.count))} ${e.event} (${whyNotBilled(e.event)})`).join('; ');
    out.findings.push({ level: 'info', text: `Not billed as analytics events: ${list}.` });
  }
  return out;
}

function whyNotBilled(event: string): string {
  if (event === '$exception') return 'billed under Error tracking';
  if (event === 'survey sent') return 'billed as Survey responses';
  if (event === '$feature_flag_called' || event === '$experiment_exposure') return 'flags are billed per /flags request instead';
  if (event.startsWith(NON_BILLABLE_EVENT_PREFIX)) return 'billed under AI observability, not estimated here';
  return 'excluded by PostHog';
}

/** $web_vitals and $dead_click: optional extras billed as ordinary events. */
function extrasFix(ctx: AnalysisContext): Fix | null {
  const events = ctx.snap.events;
  if (!events) return null;
  const find = (name: string) => events.byEvent.find((e) => e.event === name);
  const vitals = find('$web_vitals');
  const dead = find('$dead_click');
  const windowUnits = (vitals?.count ?? 0) + (dead?.count ?? 0);
  const projectEvents = ctx.project.events;
  if (windowUnits <= 0 || !projectEvents) return null;
  const units = ctx.monthlyEvents(windowUnits);
  if (units / projectEvents < 0.02) return null;
  const share = ctx.identifiedShare();
  const identifiedWindow =
    (vitals ? (vitals.identified ?? vitals.count * share) : 0) + (dead ? (dead.identified ?? dead.count * share) : 0);
  const fix: Fix = {
    id: 'autocapture-extras',
    title: 'Turn off dead-click events and Web vitals events',
    kind: 'trade-off',
    products: ['product_analytics', 'identified_events'],
    effects: [
      { key: 'events', removeFraction: fractionOf(units, ctx.org.events) },
      { key: 'identifiedEvents', removeFraction: fractionOf(ctx.monthlyIdentified(identifiedWindow), ctx.org.identifiedEvents) },
    ],
    assumption: `Drops 100% of ${[vitals && vitals.count > 0 ? '$web_vitals' : null, dead && dead.count > 0 ? '$dead_click' : null]
      .filter(Boolean)
      .join(' and ')} events (${count(units)}/mo, ${pct(units / projectEvents)} of this project's events).`,
    youLose:
      'Dead clicks as queryable events (heatmaps still show dead clicks without creating events) and the Web vitals report. Keep Web vitals if you track Core Web Vitals in PostHog.',
    steps: ['Web vitals can also be switched off in project settings; an explicit posthog.init option wins over the project setting.'],
    snippets: [],
    initOptions: [],
    docs: [
      { title: 'Dead clicks autocapture', url: `${DOCS.autocapture}#dead-clicks-autocapture` },
      { title: 'posthog-js config: capture_performance', url: DOCS.jsConfig },
    ],
    evidence: `${count(units)} $web_vitals/$dead_click events per month`,
  };
  if (dead && dead.count > 0) {
    fix.initOptions.push({ key: 'capture_dead_clicks', value: 'false', comment: 'dead clicks are billed as events; heatmaps show them for free' });
  }
  if (vitals && vitals.count > 0) {
    fix.initOptions.push({
      key: 'capture_performance',
      value: '{ web_vitals: false }',
      comment: 'no $web_vitals events (check network timing for replay is still configured as you want)',
    });
  }
  fix.evidence += ` (≈${usd(ctx.allocateEvents(units, ctx.monthlyIdentified(identifiedWindow)))}/mo).`;
  return fix;
}

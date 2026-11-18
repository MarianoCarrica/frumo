import { DOCS } from '../../posthog-facts.js';
import { count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, Fix } from '../model.js';

export function analyzePageviews(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const events = ctx.snap.events;
  if (!events) return out;
  const share = ctx.identifiedShare();
  const projectEvents = ctx.project.events;

  const make = (name: '$pageview' | '$pageleave', title: string, detail: string): Driver | null => {
    const e = events.byEvent.find((row) => row.event === name);
    if (!e || e.count <= 0) return null;
    const units = ctx.monthlyEvents(e.count);
    const identified = ctx.monthlyIdentified(e.identified ?? e.count * share);
    return {
      id: `event:${name}`,
      title,
      product: 'product_analytics',
      units,
      unitLabel: 'events',
      costUsd: ctx.allocateEvents(units, identified),
      shareOfProduct: projectEvents ? units / projectEvents : null,
      detail: `${count(units)} events/mo (${pct(projectEvents ? units / projectEvents : null)} of this project's events). ${detail}`,
      evidence: [],
      fixIds: [],
    };
  };

  const pageview = make(
    '$pageview',
    '$pageview',
    'Pageviews power Web analytics, paths and funnels, so they are usually worth keeping. If you also capture pageviews manually, check for double counting.',
  );
  if (pageview) out.drivers.push(pageview);

  const pageleave = make(
    '$pageleave',
    '$pageleave',
    'Pageleaves feed bounce rate, time on page and scroll depth. Many teams never look at them for app pages.',
  );
  if (pageleave) {
    out.drivers.push(pageleave);
    const e = events.byEvent.find((row) => row.event === '$pageleave');
    if (e && projectEvents && pageleave.units / projectEvents >= 0.03) {
      const identified = ctx.monthlyIdentified(e.identified ?? e.count * share);
      const fix: Fix = {
        id: 'pageleave-off',
        title: 'Stop automatic $pageleave events',
        kind: 'trade-off',
        products: ['product_analytics', 'identified_events'],
        effects: [
          { key: 'events', removeFraction: fractionOf(pageleave.units, ctx.org.events) },
          { key: 'identifiedEvents', removeFraction: fractionOf(identified, ctx.org.identifiedEvents) },
        ],
        assumption: `Drops 100% of $pageleave events (${count(pageleave.units)}/mo, ${pct(pageleave.units / projectEvents)} of this project's events).`,
        youLose:
          "Bounce rate, time on page and scroll depth in Web analytics become unreliable: PostHog's docs warn that disabling pageleave events may stop features like bounce rate from working.",
        steps: [
          'Keep bounce rate for the marketing site only: use capture_pageleave: isMarketingPage instead of false (isMarketingPage is defined in the combined diff when marketing pages were found).',
          "Or capture it manually where you need it: posthog.capture('$pageleave').",
        ],
        snippets: [],
        initOptions: [{ key: 'capture_pageleave', value: 'false', comment: 'no automatic $pageleave events' }],
        docs: [{ title: 'Disable pageview or pageleave events', url: `${DOCS.analyticsCuttingCosts}#disable-pageview-or-pageleave-events` }],
        evidence: `${count(pageleave.units)} $pageleave events/mo.`,
      };
      out.fixes.push(fix);
      pageleave.fixIds.push(fix.id);
    }
  }
  return out;
}

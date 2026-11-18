import { DOCS } from '../../posthog-facts.js';
import { count, pct, usd } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Fix } from '../model.js';
import { pageLabel } from '../snippets.js';

/**
 * Identified events from people who never identified: posthog-js reported `$is_identified: false`
 * yet the event was processed with a person profile. Typical causes: `person_profiles: 'always'`
 * (often from an old snippet on the marketing site), or calling group()/setPersonProperties()/alias()
 * for anonymous visitors.
 */
export function analyzePersonProfiles(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const events = ctx.snap.events;
  if (!events) return out;
  const total = events.totals.unidentifiedPersonEvents;
  if (total === null) {
    if (events.totals.billableIdentified !== null) {
      out.notAnalyzed.push('Person profiles for anonymous visitors: the snapshot has no $is_identified breakdown.');
    }
    return out;
  }
  if (total <= 0) return out;

  const units = ctx.monthlyIdentified(total);
  const addonRate = ctx.averageRate('identifiedEvents');
  const surcharge = addonRate === null ? null : units * addonRate;

  const pages = (events.byPage ?? []).filter((p) => (p.unidentifiedPersonEvents ?? 0) > 0);
  let marketing = 0;
  for (const p of pages) if (ctx.classify(p.host, p.path) === 'marketing') marketing += p.unidentifiedPersonEvents ?? 0;
  const top = [...pages].sort((a, b) => (b.unidentifiedPersonEvents ?? 0) - (a.unidentifiedPersonEvents ?? 0)).slice(0, 8);

  const fix: Fix = {
    id: 'person-profiles-identified-only',
    title: "Only create person profiles for identified users (person_profiles: 'identified_only')",
    kind: 'no-regret',
    products: ['identified_events'],
    effects: [{ key: 'identifiedEvents', removeFraction: fractionOf(units, ctx.org.identifiedEvents) }],
    assumption: `The ${count(units)}/mo identified events sent while posthog-js said the visitor was not identified become anonymous events (still captured, minus the person-profile charge). Users who log in later are unaffected.`,
    youLose:
      'Person profiles, person properties and cohorts for visitors who never log in. Their events stay queryable by event properties, and Web analytics keeps working.',
    steps: [
      "Look for person_profiles: 'always' in your posthog.init (often an old snippet on the marketing site) and remove it: 'identified_only' is the default.",
      'Also avoid group(), setPersonProperties() or alias() for anonymous visitors: each one creates a person profile. setPersonPropertiesForFlags() does not.',
    ],
    snippets: [],
    initOptions: [
      { key: 'person_profiles', value: "'identified_only'", comment: "replaces 'always' if you set it (identified_only is the default)" },
    ],
    docs: [
      { title: 'Anonymous vs identified events', url: DOCS.anonymousVsIdentified },
      { title: 'Use anonymous events (cutting costs)', url: `${DOCS.analyticsCuttingCosts}#use-anonymous-events` },
    ],
    evidence: `${count(units)} identified events/mo from visitors who never identified${pages.length > 0 ? `, ${pct(marketing / total)} of them on marketing pages` : ''}.`,
  };
  out.fixes.push(fix);

  out.drivers.push({
    id: 'person-profiles-anonymous',
    title: 'Person-profile charge on visitors who never logged in',
    product: 'identified_events',
    units,
    unitLabel: 'identified events',
    costUsd: surcharge,
    shareOfProduct: ctx.project.identifiedEvents ? units / ctx.project.identifiedEvents : null,
    detail: `${count(units)} events/mo were processed with a person profile although posthog-js reported the visitor as not identified (${pct(ctx.project.identifiedEvents ? units / ctx.project.identifiedEvents : null)} of this project's identified events). Cost shown is only the person-profile part (≈${usd(surcharge)}/mo); the events themselves stay.`,
    evidence:
      top.length > 0
        ? [
            {
              title: 'Where it happens (top pages)',
              columns: ['Page', 'Class', 'Events/mo'],
              rows: top.map((p) => [
                pageLabel(p.host, p.path),
                ctx.classify(p.host, p.path),
                count(ctx.monthlyIdentified(p.unidentifiedPersonEvents ?? 0)),
              ]),
            },
          ]
        : [],
    fixIds: [fix.id],
  });
  return out;
}

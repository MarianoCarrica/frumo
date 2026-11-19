import { DOCS } from '../../posthog-facts.js';
import { count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Effect, Fix } from '../model.js';
import { devHostPreamble, devHostRegexSource } from '../snippets.js';
import { parseUrlLoose } from '../url-class.js';

/** Local, preview and staging hosts sending events into this (production) project. */
export function analyzeDevHosts(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const hosts = ctx.snap.events?.byHost;
  if (!hosts) {
    if (ctx.snap.events) out.notAnalyzed.push('Local/preview/staging hosts: no per-host breakdown in the snapshot.');
    return out;
  }
  const dev = hosts
    .map((h) => ({ ...h, reason: ctx.classifier.devReason(h.host) }))
    .filter((h): h is typeof h & { reason: string } => h.reason !== null && h.count > 0);
  if (dev.length === 0) return out;

  const share = ctx.identifiedShare();
  const window = dev.reduce((s, h) => s + h.count, 0);
  const identWindow = dev.reduce((s, h) => s + (h.identified ?? h.count * share), 0);
  const units = ctx.monthlyEvents(window);
  const identified = ctx.monthlyIdentified(identWindow);
  const projectEvents = ctx.project.events;

  // Recordings that started on those hosts.
  let devRecordingsWindow = 0;
  for (const r of ctx.snap.replay?.byFirstUrl ?? []) {
    const parsed = parseUrlLoose(r.url);
    if (parsed && ctx.classifier.devReason(parsed.host) !== null) devRecordingsWindow += r.count;
  }
  const devRecordings = ctx.monthlyRecordings(devRecordingsWindow);

  const effects: Effect[] = [
    { key: 'events', removeFraction: fractionOf(units, ctx.org.events) },
    { key: 'identifiedEvents', removeFraction: fractionOf(identified, ctx.org.identifiedEvents) },
  ];
  if (devRecordings > 0) effects.push({ key: 'recordings', removeFraction: fractionOf(devRecordings, ctx.org.recordings) });

  const source = devHostRegexSource(
    dev.map((h) => h.host),
    ctx.options.devHostPatterns ?? [],
  );
  const preamble = source ? devHostPreamble(source) : null;
  const fix: Fix = {
    id: 'dev-hosts-off',
    title: 'Stop sending local, preview and staging traffic to this project',
    kind: 'no-regret',
    products: devRecordings > 0 ? ['product_analytics', 'identified_events', 'session_replay'] : ['product_analytics', 'identified_events'],
    effects,
    assumption: `Drops 100% of events from ${dev.length} non-production host${dev.length === 1 ? '' : 's'} (${count(units)}/mo, ${pct(projectEvents ? units / projectEvents : null)} of this project's events)${devRecordings > 0 ? ` and the ${count(devRecordings)} recordings/mo that started there` : ''}. Flag requests from these hosts also stop, but aren't counted in the estimate.`,
    youLose: 'Test data in your production project. If you need to test tracking, point dev builds at a separate project with billing limits or no PostHog at all.',
    steps: [
      'Simplest: only call posthog.init in production builds (e.g. behind your NODE_ENV / VERCEL_ENV check). The options in the diff do the same for any build that ships to these hosts.',
    ],
    snippets: [],
    initOptions: preamble
      ? [
          { key: 'opt_out_capturing_by_default', value: 'isDevHost', comment: 'no events from local/preview/staging hosts', preamble: [preamble] },
          { key: 'disable_session_recording', value: 'isDevHost', comment: 'no recordings from those hosts', preamble: [preamble] },
          { key: 'advanced_disable_flags', value: 'isDevHost', comment: 'no /flags requests from those hosts', preamble: [preamble] },
        ]
      : [],
    docs: [
      { title: 'posthog-js config', url: DOCS.jsConfig },
      { title: 'Configuring test and CI environments', url: `${DOCS.flagsCuttingCosts}#configuring-test-and-ci-environments` },
    ],
    evidence: `${count(units)} events/mo from ${dev
      .slice(0, 3)
      .map((h) => h.host)
      .join(', ')}${dev.length > 3 ? '…' : ''}.`,
  };
  out.fixes.push(fix);

  out.drivers.push({
    id: 'dev-hosts',
    title: 'Local, preview and staging hosts in this project',
    product: 'product_analytics',
    units,
    unitLabel: 'events',
    costUsd: ctx.allocateEvents(units, identified),
    shareOfProduct: projectEvents ? units / projectEvents : null,
    detail: `${count(units)} events/mo (${pct(projectEvents ? units / projectEvents : null)} of this project's events) came from hosts that look like development or preview environments.`,
    evidence: [
      {
        title: 'Non-production hosts',
        columns: ['Host', 'Why', 'Events/mo'],
        rows: [...dev].sort((a, b) => b.count - a.count).slice(0, 10).map((h) => [h.host, h.reason, count(ctx.monthlyEvents(h.count))]),
      },
    ],
    fixIds: [fix.id],
  });
  return out;
}

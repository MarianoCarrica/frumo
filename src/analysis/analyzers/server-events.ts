import { DOCS, isServerLib } from '../../posthog-facts.js';
import { count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Fix, Snippet } from '../model.js';
import { jsString } from '../snippets.js';

/** Event names that look like backend bookkeeping rather than something a person did. */
export const SYSTEM_EVENT_NAME =
  /(^|[_\s.:-])(api|requests?|jobs?|cron|workers?|tasks?|queues?|webhooks?|sync|heartbeats?|health|ping|batch|imports?|exports?|ingest(ion)?|etl|migrations?|backfills?|polls?|scheduler|scheduled)([_\s.:-]|$)/i;

/** Server SDK events processed as identified that probably don't need a person profile. */
export function analyzeServerEvents(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const rows = (ctx.snap.events?.serverEvents ?? []).filter((r) => isServerLib(r.lib) && !r.event.startsWith('$'));
  if (rows.length === 0) return out;

  const identifiedOf = (r: { count: number; identified: number | null }): number => r.identified ?? r.count;
  const totalIdentified = rows.reduce((s, r) => s + identifiedOf(r), 0);
  if (totalIdentified <= 0) return out;
  const system = rows.filter((r) => SYSTEM_EVENT_NAME.test(r.event) && identifiedOf(r) > 0);
  const systemIdentified = system.reduce((s, r) => s + identifiedOf(r), 0);

  const units = ctx.monthlyIdentified(totalIdentified);
  const allEvents = ctx.monthlyEvents(rows.reduce((s, r) => s + r.count, 0));
  const libs = [...new Set(rows.map((r) => r.lib))];
  const driver = {
    id: 'server-identified-events',
    title: `Server-side events processed as identified (${libs.join(', ')})`,
    product: 'identified_events' as const,
    units,
    unitLabel: 'identified events',
    costUsd: ctx.allocateEvents(allEvents, units),
    shareOfProduct: ctx.project.identifiedEvents ? units / ctx.project.identifiedEvents : null,
    detail: `Server SDKs capture identified events by default. ${count(units)} identified events/mo come from ${libs.join(', ')}; ${count(ctx.monthlyIdentified(systemIdentified))} of them have names that look like backend bookkeeping.`,
    evidence: [
      {
        title: 'Top server-side events',
        columns: ['Event', 'SDK', 'Events/mo', 'Identified', 'Looks like system activity'],
        rows: [...rows]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((r) => [
            r.event,
            r.lib,
            count(ctx.monthlyEvents(r.count)),
            pct(r.count > 0 ? identifiedOf(r) / r.count : 0),
            SYSTEM_EVENT_NAME.test(r.event) ? 'yes' : '',
          ]),
      },
    ],
    fixIds: [] as string[],
  };
  out.drivers.push(driver);

  const systemUnits = ctx.monthlyIdentified(systemIdentified);
  if (systemIdentified <= 0 || !ctx.project.identifiedEvents || systemUnits / ctx.project.identifiedEvents < 0.01) return out;

  const names = system.slice(0, 4).map((r) => r.event);
  const lib = system[0]?.lib ?? 'posthog-node';
  const fix: Fix = {
    id: 'server-anonymous-events',
    title: 'Send backend bookkeeping events without person processing',
    kind: 'trade-off',
    products: ['identified_events'],
    effects: [{ key: 'identifiedEvents', removeFraction: fractionOf(systemUnits, ctx.org.identifiedEvents) }],
    assumption: `Events whose names look like system activity (${names.join(', ')}: ${count(systemUnits)}/mo) are sent as anonymous events. Their event volume is unchanged; only the person-profile charge goes.`,
    youLose:
      'These events no longer link to the person, so no person properties or cohorts on them. Keep the user ID as a plain event property for filtering.',
    steps: [
      'Use a distinct ID that is not linked to a person (PostHog: events for an existing person are still billed as identified even with person processing off). A random UUID per request/job works; don\'t share one constant ID across all events.',
    ],
    snippets: [serverSnippet(lib, names[0] ?? 'api_request')],
    initOptions: [],
    docs: [{ title: 'Capturing anonymous events from the backend', url: `${DOCS.anonymousVsIdentified}#how-to-capture-anonymous-events` }],
    evidence: `${count(systemUnits)} identified backend events/mo (${names.join(', ')}).`,
  };
  out.fixes.push(fix);
  driver.fixIds.push(fix.id);
  return out;
}

function serverSnippet(lib: string, event: string): Snippet {
  if (lib === 'posthog-python') {
    return {
      title: 'posthog-python',
      language: 'python',
      code: [
        'import uuid',
        '',
        'posthog.capture(',
        `    ${JSON.stringify(event)},`,
        '    distinct_id=str(uuid.uuid4()),  # not the user\'s ID: events for an existing person are billed as identified',
        '    properties={"user_id": user.id},  # keep it filterable',
        '    options={"process_person_profile": False},',
        ')',
      ].join('\n'),
    };
  }
  return {
    title: lib === 'posthog-node' ? 'posthog-node' : `${lib} (Node.js shown; other SDKs use the $process_person_profile property)`,
    language: 'js',
    code: [
      "import { randomUUID } from 'node:crypto'",
      '',
      'posthog.capture({',
      "  distinctId: randomUUID(), // not the user's ID: events for an existing person are billed as identified",
      `  event: ${jsString(event)},`,
      '  properties: { user_id: user.id }, // keep it filterable',
      '  options: { process_person_profile: false },',
      '})',
    ].join('\n'),
  };
}

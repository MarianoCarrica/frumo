import { DOCS, WEB_LIB, botToken, isServerLib } from '../../posthog-facts.js';
import { clip, count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Fix, Snippet } from '../model.js';
import { escapeRegex, jsArray, jsString, regexLiteral } from '../snippets.js';

/** Bots, crawlers, synthetic monitoring and non-browser HTTP clients that send events. */
export function analyzeBots(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const rows = ctx.snap.events?.bots;
  if (!rows) {
    if (ctx.snap.events) out.notAnalyzed.push('Bot traffic: no user-agent breakdown in the snapshot.');
    return out;
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total <= 0) return out;
  const share = ctx.identifiedShare();
  const identifiedWindow = rows.reduce((s, r) => s + (r.identified ?? r.count * share), 0);
  const units = ctx.monthlyEvents(total);
  const identified = ctx.monthlyIdentified(identifiedWindow);
  const projectEvents = ctx.project.events;

  const webRows = rows.filter((r) => r.lib === WEB_LIB);
  const serverRows = rows.filter((r) => isServerLib(r.lib));
  const tokens = [...new Set(rows.map((r) => botToken(r.userAgent)))].slice(0, 12);
  const webTokens = [...new Set(webRows.map((r) => botToken(r.userAgent)))].slice(0, 12);

  const snippets: Snippet[] = [];
  if (serverRows.length > 0) {
    snippets.push({
      title: `Server-side capture (${[...new Set(serverRows.map((r) => r.lib))].join(', ')}): skip bots before calling capture()`,
      language: 'js',
      code: [
        `const BOT_UA = ${regexLiteral(tokens.map(escapeRegex).join('|'), 'i')}`,
        '',
        "if (!BOT_UA.test(req.headers['user-agent'] ?? '')) {",
        "  posthog.capture({ distinctId, event: '$pageview', properties: { $current_url: url } })",
        '}',
      ].join('\n'),
    });
  }

  const fix: Fix = {
    id: 'bots-filter',
    title: 'Drop bot, crawler and monitoring traffic',
    kind: 'no-regret',
    products: ['product_analytics', 'identified_events'],
    effects: [
      { key: 'events', removeFraction: fractionOf(units, ctx.org.events) },
      { key: 'identifiedEvents', removeFraction: fractionOf(identified, ctx.org.identifiedEvents) },
    ],
    assumption: `Drops 100% of events from the ${rows.length} bot/non-browser user agent${rows.length === 1 ? '' : 's'} listed (${count(units)}/mo, ${pct(projectEvents ? units / projectEvents : null)} of this project's events).`,
    youLose: 'Nothing useful: these are crawlers, uptime checks and scripts, not people. Check the list for anything you rely on (e.g. a synthetic check you analyse).',
    steps: [
      'posthog-js already drops many known bots; custom_blocked_useragents adds yours (case-insensitive substring match).',
      'If a synthetic-monitoring account logs in, also exclude it with your internal/test account filters.',
    ],
    snippets,
    initOptions:
      webTokens.length > 0
        ? [{ key: 'custom_blocked_useragents', value: jsArray(webTokens.map(jsString)), comment: 'bots seen in your data that posthog-js does not block by default' }]
        : [],
    docs: [{ title: 'Blocking bad actors', url: DOCS.blockingBots }],
    evidence: `${count(units)} events/mo from ${tokens.slice(0, 4).join(', ')}${tokens.length > 4 ? '…' : ''}.`,
  };
  out.fixes.push(fix);

  out.drivers.push({
    id: 'bots',
    title: 'Bots, crawlers and monitoring scripts',
    product: 'product_analytics',
    units,
    unitLabel: 'events',
    costUsd: ctx.allocateEvents(units, identified),
    shareOfProduct: projectEvents ? units / projectEvents : null,
    detail: `${count(units)} events/mo (${pct(projectEvents ? units / projectEvents : null)} of this project's events) came from user agents that are not people${identified > 0 ? `, ${pct(identified / units)} of them identified` : ''}.`,
    evidence: [
      {
        title: 'Bot and non-browser user agents',
        columns: ['User agent', 'SDK', 'Events/mo'],
        rows: [...rows]
          .sort((a, b) => b.count - a.count)
          .slice(0, 10)
          .map((r) => [clip(r.userAgent, 70), r.lib ?? '', count(ctx.monthlyEvents(r.count))]),
      },
    ],
    fixIds: [fix.id],
  });
  return out;
}

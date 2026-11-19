import { DOCS } from '../../posthog-facts.js';
import { clip, count, pct, usd } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, EvidenceTable, Fix } from '../model.js';
import { jsArray, jsString, marketingScope, pageLabel, regexLiteral } from '../snippets.js';
import type { AutocaptureElementRow } from '../../snapshot.js';

/** Elements people usually analyse even when clicked a lot. */
const CONVERSION_TEXT =
  /sign ?up|log ?in|sign ?in|buy|purchase|checkout|subscribe|upgrade|trial|book|demo|contact|download|submit|save|create|invite|pay|get started|register|add to cart|start/i;

/** A CSS class name frumo is willing to put in a selector. */
const SAFE_CLASS = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

const MIN_CLICKS_PER_SESSION = 4;

export function elementLabel(e: AutocaptureElementRow): string {
  const text = e.text ? ` "${clip(e.text, 30)}"` : '';
  return `${e.tag ?? '?'}${e.classes ?? ''}${text}`;
}

export function elementSelector(e: AutocaptureElementRow): string | null {
  const first = (e.classes ?? '').split('.').find((c) => c.length > 0);
  return first && SAFE_CLASS.test(first) ? `.${first}` : null;
}

export function analyzeAutocapture(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const events = ctx.snap.events;
  const ac = events?.byEvent.find((e) => e.event === '$autocapture');
  if (!events || !ac || ac.count <= 0) return out;

  const projectEvents = ctx.project.events;
  const units = ctx.monthlyEvents(ac.count);
  const identifiedWindow = ac.identified ?? ac.count * ctx.identifiedShare();
  const identRatio = identifiedWindow / ac.count;
  const cost = ctx.allocateEvents(units, ctx.monthlyIdentified(identifiedWindow));
  const driver: Driver = {
    id: 'event:$autocapture',
    title: '$autocapture (autocaptured clicks, changes and submits)',
    product: 'product_analytics',
    units,
    unitLabel: 'events',
    costUsd: cost,
    shareOfProduct: projectEvents ? units / projectEvents : null,
    detail: `${count(units)} events/mo, ${pct(projectEvents ? units / projectEvents : null)} of this project's events, ${pct(identRatio)} identified. Turning autocapture off entirely would remove all of them (≈${usd(cost)}/mo at your average rate); the fixes below keep the useful part.`,
    evidence: [],
    fixIds: [],
  };
  out.drivers.push(driver);

  if (ctx.snap.projectSettings?.autocaptureOptOut === true) {
    out.findings.push({
      level: 'warning',
      text: 'Autocapture is switched off in project settings, but $autocapture events still arrive: some SDK probably sets autocapture: true in code.',
    });
  }

  // Where autocapture happens.
  const pages = (events.byPage ?? []).filter((p) => p.autocapture > 0);
  const pageTotal = pages.reduce((s, p) => s + p.autocapture, 0);
  if (pages.length > 0) {
    driver.evidence.push(pageEvidence(ctx, pages, ac.count, pageTotal));
  }

  // Fix A: no autocapture on marketing pages.
  let marketingWindow = 0;
  let marketingIdentWindow = 0;
  for (const p of pages) {
    if (ctx.classify(p.host, p.path) !== 'marketing') continue;
    marketingWindow += p.autocapture;
    const pageIdentRatio = p.identified !== null && p.count > 0 ? p.identified / p.count : identRatio;
    marketingIdentWindow += p.autocapture * pageIdentRatio;
  }
  const scope = marketingScope(ctx);
  if (marketingWindow / ac.count >= 0.03 && scope.regexSources.length > 0) {
    const m = ctx.monthlyEvents(marketingWindow);
    const fix: Fix = {
      id: 'autocapture-marketing-pages',
      title: 'Stop autocapture on marketing and docs pages',
      kind: 'trade-off',
      products: ['product_analytics', 'identified_events'],
      effects: [
        { key: 'events', removeFraction: fractionOf(m, ctx.org.events) },
        { key: 'identifiedEvents', removeFraction: fractionOf(ctx.monthlyIdentified(marketingIdentWindow), ctx.org.identifiedEvents) },
      ],
      assumption: `Drops 100% of $autocapture on pages classified as marketing/content (${count(m)}/mo, ${pct(marketingWindow / ac.count)} of autocapture${scope.hosts.length > 0 ? `: ${scope.hosts.join(', ')}` : ''}). Pageviews and custom events there are unchanged.`,
      youLose:
        'Click and form events on those pages, so no autocapture-based funnels there. Heatmaps still work and create no extra events; track the few clicks you care about (like the sign-up CTA) with posthog.capture().',
      steps: [
        "Need the CTA clicks? Track them explicitly: posthog.capture('cta_clicked', { cta: 'hero_signup' })",
        'Check the patterns match only marketing URLs before shipping (see "How URLs were classified").',
      ],
      snippets: [],
      initOptions: [
        {
          key: 'autocapture.url_ignorelist',
          value: jsArray(scope.regexSources.map((s) => regexLiteral(s))),
          comment: 'no autocapture on marketing/docs pages',
        },
      ],
      docs: [{ title: 'Configuring interaction autocapture', url: `${DOCS.autocapture}#configuring-interaction-autocapture` }],
      evidence: `${count(m)} autocaptured events/mo on marketing pages.`,
    };
    out.fixes.push(fix);
    driver.fixIds.push(fix.id);
  }

  // Fix B: no autocaptured "change" events.
  const domRows = events.autocaptureDomEvents ?? [];
  if (domRows.length > 0) {
    const domTotal = domRows.reduce((s, r) => s + r.count, 0);
    const change = domRows
      .filter((r) => r.domEvent === 'change' && ctx.classify(r.host, '/') !== 'marketing')
      .reduce((s, r) => s + r.count, 0);
    driver.evidence.push({
      title: 'Autocapture by DOM event',
      columns: ['DOM event', 'Events/mo', 'Share'],
      rows: aggregateDom(domRows).map(([dom, c]) => [dom, count(ctx.monthlyEvents(c)), pct(domTotal > 0 ? c / domTotal : 0)]),
    });
    if (change / ac.count >= 0.05) {
      const m = ctx.monthlyEvents(change);
      const fix: Fix = {
        id: 'autocapture-dom-events',
        title: 'Autocapture only clicks and form submits (skip input changes)',
        kind: 'trade-off',
        products: ['product_analytics', 'identified_events'],
        effects: [
          { key: 'events', removeFraction: fractionOf(m, ctx.org.events) },
          { key: 'identifiedEvents', removeFraction: fractionOf(ctx.monthlyIdentified(change * identRatio), ctx.org.identifiedEvents) },
        ],
        assumption: `Drops 100% of autocaptured "change" events outside marketing pages (${count(m)}/mo, ${pct(change / ac.count)} of autocapture).`,
        youLose: 'Which input or select a user changed. Clicks and form submits are still captured.',
        steps: [],
        snippets: [],
        initOptions: [
          { key: 'autocapture.dom_event_allowlist', value: "['click', 'submit']", comment: 'skip autocaptured input/select changes' },
        ],
        docs: [{ title: 'Configuring interaction autocapture', url: `${DOCS.autocapture}#configuring-interaction-autocapture` }],
        evidence: `${count(m)} autocaptured "change" events/mo.`,
      };
      out.fixes.push(fix);
      driver.fixIds.push(fix.id);
    }
  }

  // Fix C: ignore the noisiest elements.
  const elements = events.autocaptureElements ?? [];
  if (elements.length > 0) {
    driver.evidence.push(elementEvidence(ctx, elements.slice(0, 10)));
    const noisy = elements.filter(
      (e) =>
        (e.domEvent === 'click' || e.domEvent === null) &&
        e.sessions !== null &&
        e.sessions > 0 &&
        e.count / e.sessions >= MIN_CLICKS_PER_SESSION &&
        e.count / ac.count >= 0.01 &&
        ctx.classify(e.host, '/') !== 'marketing' &&
        !CONVERSION_TEXT.test(e.text ?? ''),
    );
    const noisyWindow = noisy.reduce((s, e) => s + e.count, 0);
    if (noisy.length > 0 && noisyWindow / ac.count >= 0.03) {
      const selectors = [...new Set(noisy.map(elementSelector).filter((s): s is string => s !== null))];
      const unselectable = noisy.filter((e) => elementSelector(e) === null);
      const m = ctx.monthlyEvents(noisyWindow);
      const fix: Fix = {
        id: 'autocapture-noisy-elements',
        title: `Ignore the ${noisy.length} noisiest autocaptured element${noisy.length === 1 ? '' : 's'}`,
        kind: 'trade-off',
        products: ['product_analytics', 'identified_events'],
        effects: [
          { key: 'events', removeFraction: fractionOf(m, ctx.org.events) },
          { key: 'identifiedEvents', removeFraction: fractionOf(ctx.monthlyIdentified(noisyWindow * identRatio), ctx.org.identifiedEvents) },
        ],
        assumption: `Drops 100% of $autocapture from elements clicked ${MIN_CLICKS_PER_SESSION}+ times per session on average that each make up ≥1% of autocapture (${count(m)}/mo, ${pct(noisyWindow / ac.count)} of autocapture). Picked by volume and clicks per session; review the list.`,
        youLose: `Per-click events for: ${noisy.slice(0, 5).map(elementLabel).join(', ')}. Use posthog.capture() for any of these you analyse.`,
        steps: [
          'css_selector_ignorelist replaces the default ignore list, so the snippet keeps .ph-no-autocapture and [data-ph-no-autocapture].',
          ...(unselectable.length > 0
            ? [`Elements without a usable class need class="ph-no-autocapture" in your markup: ${unselectable.map(elementLabel).join(', ')}`]
            : []),
        ],
        snippets: [],
        initOptions:
          selectors.length > 0
            ? [
                {
                  key: 'autocapture.css_selector_ignorelist',
                  value: jsArray(["'.ph-no-autocapture'", "'[data-ph-no-autocapture]'", ...selectors.map(jsString)]),
                  comment: 'ignore the noisiest elements (keeps the default ignore list)',
                },
              ]
            : [],
        docs: [{ title: 'Configuring interaction autocapture', url: `${DOCS.autocapture}#configuring-interaction-autocapture` }],
        evidence: `${noisy.length} element(s) averaging ${MIN_CLICKS_PER_SESSION}+ clicks per session.`,
      };
      out.fixes.push(fix);
      driver.fixIds.push(fix.id);
    }
  }
  return out;
}

function aggregateDom(rows: ReadonlyArray<{ domEvent: string | null; count: number }>): Array<[string, number]> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.domEvent ?? '(other)', (map.get(r.domEvent ?? '(other)') ?? 0) + r.count);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function pageEvidence(
  ctx: AnalysisContext,
  pages: ReadonlyArray<{ host: string; path: string; autocapture: number }>,
  total: number,
  pageTotal: number,
): EvidenceTable {
  const top = [...pages].sort((a, b) => b.autocapture - a.autocapture).slice(0, 10);
  return {
    title: 'Where autocapture happens (top pages)',
    columns: ['Page', 'Class', 'Events/mo', 'Share'],
    rows: top.map((p) => [pageLabel(p.host, p.path), ctx.classify(p.host, p.path), count(ctx.monthlyEvents(p.autocapture)), pct(p.autocapture / total)]),
    ...(pageTotal < total * 0.98 ? { note: `Top pages cover ${pct(pageTotal / total)} of autocapture.` } : {}),
  };
}

function elementEvidence(ctx: AnalysisContext, rows: readonly AutocaptureElementRow[]): EvidenceTable {
  return {
    title: 'Most autocaptured elements',
    columns: ['Element', 'DOM event', 'Host', 'Events/mo', 'Per session'],
    rows: rows.map((e) => [
      elementLabel(e),
      e.domEvent ?? '',
      e.host ?? '',
      count(ctx.monthlyEvents(e.count)),
      e.sessions ? (e.count / e.sessions).toFixed(1) : 'n/a',
    ]),
  };
}

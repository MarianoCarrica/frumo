import { DOCS } from '../../posthog-facts.js';
import { clip, count, pct } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, Fix } from '../model.js';
import { escapeRegex } from '../snippets.js';
import { parseUrlLoose } from '../url-class.js';

const SHORT_SECONDS = 5;

export function analyzeReplay(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const replay = ctx.snap.replay;
  const settings = ctx.snap.projectSettings;
  const projectRecordings = ctx.project.recordings ?? (replay ? ctx.monthly(replay.recordings) : null);

  if ((ctx.project.mobileRecordings ?? 0) > 0) {
    const units = ctx.project.mobileRecordings ?? 0;
    out.drivers.push({
      id: 'replay:mobile',
      title: 'Mobile session recordings',
      product: 'mobile_replay',
      units,
      unitLabel: 'mobile recordings',
      costUsd: ctx.allocate('mobileRecordings', units),
      shareOfProduct: null,
      detail: `${count(units)} mobile recordings/mo. Trigger groups (sampling, minimum duration, event triggers) apply to mobile SDKs too.`,
      evidence: [],
      fixIds: [],
    });
  }

  if (projectRecordings === null || projectRecordings <= 0) {
    if (!replay) out.notAnalyzed.push('Session replay: no recording data in the snapshot.');
    return out;
  }

  const rate = settings?.sessionRecordingSampleRate ?? null;
  const minMs = settings?.sessionRecordingMinimumDurationMs ?? null;
  const settingsText = settings
    ? `Settings: sample rate ${rate === null ? 'not set (100%)' : pct(rate)}, minimum duration ${minMs ? `${minMs / 1000}s` : 'not set'}${settings.sessionRecordingTriggerGroupCount ? `, ${settings.sessionRecordingTriggerGroupCount} trigger group(s)` : ''}${settings.sessionRecordingUrlTriggerCount ? `, ${settings.sessionRecordingUrlTriggerCount} URL trigger(s)` : ''}.`
    : 'Project replay settings were not available.';
  const all: Driver = {
    id: 'replay:all',
    title: 'Session recordings',
    product: 'session_replay',
    units: projectRecordings,
    unitLabel: 'recordings',
    costUsd: ctx.allocate('recordings', projectRecordings),
    shareOfProduct: ctx.org.recordings ? projectRecordings / ctx.org.recordings : null,
    detail: `${count(projectRecordings)} web recordings/mo in this project. ${settingsText}`,
    evidence: [],
    fixIds: [],
  };
  out.drivers.push(all);

  if (settings?.sessionRecordingOptIn === false) {
    out.findings.push({ level: 'warning', text: 'Session replay is switched off in project settings, yet recordings arrived in the period (maybe it was switched off recently).' });
  }
  if (!replay || replay.recordings <= 0) {
    out.notAnalyzed.push('Session replay breakdown (duration, first URL): no session_replay_events data in the snapshot.');
    return out;
  }

  const appHost = ctx.appHost();

  // Short recordings.
  const under5 = replay.durations?.under5s ?? null;
  if (under5 !== null && under5 > 0) {
    const short = ctx.monthlyRecordings(under5);
    const shareShort = under5 / replay.recordings;
    const shortDriver: Driver = {
      id: 'replay:short',
      title: `Recordings shorter than ${SHORT_SECONDS} seconds`,
      product: 'session_replay',
      units: short,
      unitLabel: 'recordings',
      costUsd: ctx.allocate('recordings', short),
      shareOfProduct: shareShort,
      detail: `${pct(shareShort)} of recordings (${count(short)}/mo) last under ${SHORT_SECONDS} seconds: mostly bounces with nothing to watch.`,
      evidence: replay.durations
        ? [
            {
              title: 'Recording length',
              columns: ['Shorter than', 'Recordings/mo', 'Share'],
              rows: (
                [
                  ['5s', replay.durations.under5s],
                  ['10s', replay.durations.under10s],
                  ['30s', replay.durations.under30s],
                  ['60s', replay.durations.under60s],
                ] as const
              ).map(([label, n]) => [label, count(ctx.monthlyRecordings(n)), pct(n / replay.recordings)]),
            },
          ]
        : [],
      fixIds: [],
    };
    out.drivers.push(shortDriver);
    if (shareShort >= 0.05 && (minMs === null || minMs < SHORT_SECONDS * 1000)) {
      const fix: Fix = {
        id: 'replay-min-duration',
        title: `Set a ${SHORT_SECONDS}-second minimum recording duration`,
        kind: 'no-regret',
        products: ['session_replay'],
        effects: [{ key: 'recordings', removeFraction: fractionOf(short, ctx.org.recordings) }],
        assumption: `Recordings under ${SHORT_SECONDS}s (${count(short)}/mo, ${pct(shareShort)} of recordings) are no longer kept. Current minimum: ${minMs ? `${minMs / 1000}s` : 'none'}.`,
        youLose: `Replays of visits shorter than ${SHORT_SECONDS} seconds. Their events are still captured.`,
        steps: [
          `Replay settings → trigger groups → Minimum duration: ${SHORT_SECONDS} seconds (${appHost}/replay/settings#selectedSetting=replay-triggers). Each trigger group has its own minimum.`,
          'With posthog-js 1.291.0+ and defaults: \'2025-11-30\' or later, the minimum is enforced strictly (needs that much continuous data on one page).',
        ],
        snippets: [],
        initOptions: [],
        docs: [{ title: 'Minimum duration', url: `${DOCS.replayControls}#minimum-duration` }],
        evidence: `${pct(shareShort)} of recordings are under ${SHORT_SECONDS}s.`,
      };
      out.fixes.push(fix);
      shortDriver.fixIds.push(fix.id);
      all.fixIds.push(fix.id);
    }
  }

  // Where recordings start.
  const rows = replay.byFirstUrl ?? [];
  if (rows.length > 0) {
    const classified = rows.map((r) => {
      const parsed = parseUrlLoose(r.url);
      return { ...r, urlClass: parsed ? ctx.classify(parsed.host, parsed.path) : ('unknown' as const), host: parsed?.host ?? '' };
    });
    all.evidence.push({
      title: 'Where recordings start (top first URLs)',
      columns: ['First URL', 'Class', 'Recordings/mo', `Under ${SHORT_SECONDS}s`, 'Single page'],
      rows: classified
        .slice(0, 10)
        .map((r) => [
          clip(r.url, 60),
          r.urlClass,
          count(ctx.monthlyRecordings(r.count)),
          pct(r.count > 0 ? r.under5s / r.count : 0),
          r.singleUrl === null ? 'n/a' : pct(r.count > 0 ? r.singleUrl / r.count : 0),
        ]),
    });
    const marketing = classified.filter((r) => r.urlClass === 'marketing');
    const marketingTotal = marketing.reduce((s, r) => s + r.count, 0);
    if (marketingTotal > 0) {
      const units = ctx.monthlyRecordings(marketingTotal);
      const driver: Driver = {
        id: 'replay:marketing',
        title: 'Recordings that start on marketing pages',
        product: 'session_replay',
        units,
        unitLabel: 'recordings',
        costUsd: ctx.allocate('recordings', units),
        shareOfProduct: marketingTotal / replay.recordings,
        detail: `${pct(marketingTotal / replay.recordings)} of recordings (${count(units)}/mo) start on marketing/content pages.`,
        evidence: [],
        fixIds: [],
      };
      out.drivers.push(driver);
      const singleKnown = marketing.every((r) => r.singleUrl !== null);
      const removable = singleKnown ? marketing.reduce((s, r) => s + (r.singleUrl ?? 0), 0) : marketingTotal;
      const appHosts = [...new Set(classified.filter((r) => r.urlClass === 'app').map((r) => r.host))].slice(0, 3);
      if (removable / replay.recordings >= 0.05) {
        const m = ctx.monthlyRecordings(removable);
        const trigger = appHosts.length > 0 ? `https://(${appHosts.map(escapeRegex).join('|')})/.*` : 'https://app\\.example\\.com/.*';
        const fix: Fix = {
          id: 'replay-app-only',
          title: 'Record sessions only once they reach your app (URL trigger)',
          kind: 'trade-off',
          products: ['session_replay'],
          effects: [{ key: 'recordings', removeFraction: fractionOf(m, ctx.org.recordings) }],
          assumption: singleKnown
            ? `Recordings that start on a marketing page and never visit another URL (${count(m)}/mo, ${pct(removable / replay.recordings)} of recordings) are no longer recorded. Visitors who go on to the app are still recorded from the trigger, with a short buffered lead-in.`
            : `Recordings that start on marketing pages (${count(m)}/mo) are no longer recorded. This is an upper bound: the snapshot doesn't say how many of them later reach the app, and those would still be recorded.`,
          youLose: 'Replays of marketing-only visits (useful for landing-page UX research). Heatmaps still cover those pages without recordings.',
          steps: [
            `Replay settings → trigger groups → add a URL trigger matching your app, e.g. ${trigger} (${appHost}/replay/settings#selectedSetting=replay-triggers). Patterns are regexes that must match the full URL.`,
            'A session is recorded if it matches any trigger group; make sure no other group still records everything at 100%.',
          ],
          snippets: [],
          initOptions: [],
          docs: [{ title: 'URL triggers and trigger groups', url: `${DOCS.replayControls}#url-triggers` }],
          evidence: `${pct(marketingTotal / replay.recordings)} of recordings start on marketing pages.`,
        };
        out.fixes.push(fix);
        driver.fixIds.push(fix.id);
        all.fixIds.push(fix.id);
      }
    }
  }

  // Sampling.
  const groups = settings?.sessionRecordingTriggerGroupCount ?? 0;
  const replayLine = ctx.baseCost.lines.find((l) => l.usageKey === 'recordings');
  if (settings && (rate === null || rate >= 1) && groups === 0 && (replayLine?.usd ?? 0) >= 25) {
    const half = projectRecordings * 0.5;
    const fix: Fix = {
      id: 'replay-sampling',
      title: 'Sample 50% of sessions',
      kind: 'trade-off',
      products: ['session_replay'],
      effects: [{ key: 'recordings', removeFraction: fractionOf(half, ctx.org.recordings) }],
      assumption: 'Records 50% of sessions (decided per session ID, so a session is either fully recorded or not). Pick your own rate: the saving scales roughly linearly.',
      youLose: 'Half of your replays, chosen at random. Keep 100% for the sessions you care about (checkout, errors) with a dedicated trigger group and sample the rest.',
      steps: [`Replay settings → trigger groups → sample rate 50% (${appHost}/replay/settings#selectedSetting=replay-triggers).`],
      snippets: [],
      initOptions: [],
      docs: [{ title: 'Sampling', url: `${DOCS.replayControls}#sampling` }],
      evidence: 'No sampling is configured (every session is recorded).',
    };
    out.fixes.push(fix);
    all.fixIds.push(fix.id);
  }
  return out;
}

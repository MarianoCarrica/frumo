import { DOCS } from '../../posthog-facts.js';
import { count, pct, usd } from '../../report/format.js';
import { PRODUCT_FOR_USAGE, USAGE_KEYS } from '../../snapshot.js';
import type { Usage, UsageKey } from '../../snapshot.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput, looksLikeStagingProject } from '../context.js';
import { applyEffects, fractionOf, savingBetween } from '../costs.js';
import type { Effect, Fix } from '../model.js';

const LABELS: Record<UsageKey, string> = {
  events: 'events',
  identifiedEvents: 'identified events',
  recordings: 'recordings',
  mobileRecordings: 'mobile recordings',
  flagRequests: 'flag requests',
  surveyResponses: 'survey responses',
  exceptions: 'exceptions',
};

/** Other projects in the organization share the free allowance and push you up the tiers. */
export function analyzeStaging(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const rows = ctx.snap.orgUsage;
  if (!rows || rows.length === 0) {
    out.notAnalyzed.push('Other projects (staging/dev) sharing your allowance: no organization usage in the snapshot (needs billing:read in live mode).');
    return out;
  }
  const others = rows.filter((r) => !r.audited && r.projectId !== ctx.snap.project.id);
  for (const project of others) {
    const usage: Usage = { ...project.usage };
    const monthly: Usage = { ...usage };
    for (const key of USAGE_KEYS) monthly[key] = usage[key] === null ? null : (usage[key] ?? 0) * ctx.monthlyFactor;
    const effects: Effect[] = USAGE_KEYS.filter((k) => (monthly[k] ?? 0) > 0).map((k) => ({
      key: k,
      removeFraction: fractionOf(monthly[k] ?? 0, ctx.org[k]),
    }));
    if (effects.length === 0) continue;
    const name = project.name ?? `project ${project.projectId}`;
    const staging = looksLikeStagingProject(project.name);
    const after = applyEffects(ctx.org, effects);
    const share = savingBetween(ctx.org, after, ctx.pricing).savingUsd;
    const volumes = USAGE_KEYS.filter((k) => (monthly[k] ?? 0) > 0 && k !== 'identifiedEvents')
      .map((k) => `${count(monthly[k])} ${LABELS[k]}`)
      .join(', ');

    const evidence = {
      title: `Usage in "${name}"`,
      columns: ['Meter', 'Per month', 'Share of organization'],
      rows: USAGE_KEYS.filter((k) => (monthly[k] ?? 0) > 0).map((k) => [LABELS[k], count(monthly[k]), pct(fractionOf(monthly[k] ?? 0, ctx.org[k]))]),
    };

    if (!staging) {
      out.findings.push({
        level: 'info',
        text: `Project "${name}" also uses the shared allowance (${volumes}; ≈${usd(share)}/mo of the bill). Run hogpost with --project ${project.projectId} to audit it.`,
      });
      continue;
    }

    const fix: Fix = {
      id: `staging-project-${project.projectId}`,
      title: `Stop sending staging traffic from "${name}" to PostHog Cloud`,
      kind: 'trade-off',
      products: [...new Set(effects.map((e) => PRODUCT_FOR_USAGE[e.key]))],
      effects,
      assumption: `Removes 100% of "${name}" usage (${volumes}). Usage and free allowances are organization-wide, so this traffic also pushes production into higher tiers. Keeping a 10% sample would save about 90% of this.`,
      youLose: 'Analytics, replays and flag evaluation from staging. Test instrumentation locally with posthog.debug() or in a short-lived project instead.',
      steps: [
        'In the staging build: skip posthog.init, or set autocapture: false and disable_session_recording: true and sample events in before_send.',
        'Server-side in staging: bootstrap or hard-code flag values instead of calling PostHog for every check.',
        'Billing limits are per organization and product, not per project, so they cannot cap staging on its own.',
      ],
      snippets: [
        {
          title: 'Staging build: no replays or autocapture, 10% of events',
          language: 'js',
          code: [
            "posthog.init('<staging_project_token>', {",
            '  autocapture: false,',
            '  disable_session_recording: true,',
            '  advanced_disable_feature_flags: true, // no surveys either; drop this line if staging tests surveys',
            '  before_send: (event) => (event && Math.random() < 0.1 ? event : null),',
            '})',
          ].join('\n'),
        },
      ],
      initOptions: [],
      docs: [
        { title: 'Configuring test and CI environments', url: `${DOCS.flagsCuttingCosts}#configuring-test-and-ci-environments` },
        { title: 'Amending or sampling events (before_send)', url: DOCS.beforeSend },
      ],
      evidence: `"${name}": ${volumes} per month.`,
    };
    out.fixes.push(fix);
    out.drivers.push({
      id: `staging-project:${project.projectId}`,
      title: `Staging project "${name}" shares your allowance`,
      product: monthly.flagRequests && monthly.flagRequests > (monthly.events ?? 0) ? 'feature_flags' : 'product_analytics',
      units: monthly.events ?? 0,
      unitLabel: 'events',
      costUsd: share,
      shareOfProduct: null,
      detail: `${volumes} per month. Cost shown is what removing the project would save at your tiers.`,
      evidence: [evidence],
      fixIds: [fix.id],
    });
  }
  return out;
}

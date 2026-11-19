import { count } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';

/** Surveys and error tracking: cost lines only (v1 has no dedicated fixes for them). */
export function analyzeOtherProducts(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const surveys = ctx.project.surveyResponses;
  if (surveys !== null && surveys > 0) {
    out.drivers.push({
      id: 'surveys',
      title: 'Survey responses',
      product: 'surveys',
      units: surveys,
      unitLabel: 'responses',
      costUsd: ctx.allocate('surveyResponses', surveys),
      shareOfProduct: null,
      detail: `${count(surveys)} survey responses/mo (free allowance: ${count(ctx.pricing.table.products.surveys.freeAllowance)}).`,
      evidence: [],
      fixIds: [],
    });
  }
  const exceptions = ctx.project.exceptions;
  if (exceptions !== null && exceptions > 0) {
    const cost = ctx.allocate('exceptions', exceptions);
    out.drivers.push({
      id: 'exceptions',
      title: 'Captured exceptions ($exception)',
      product: 'error_tracking',
      units: exceptions,
      unitLabel: 'exceptions',
      costUsd: cost,
      shareOfProduct: null,
      detail: `${count(exceptions)} exceptions/mo (free allowance: ${count(ctx.pricing.table.products.error_tracking.freeAllowance)}).`,
      evidence: [],
      fixIds: [],
    });
    if (cost !== null && cost > 0) {
      out.findings.push({
        level: 'info',
        text: 'Error tracking is above the free tier: suppression rules drop matching exceptions before ingestion (not billed), and exception autocapture can be narrowed. See posthog.com/docs/error-tracking/pricing.',
      });
    }
  }
  out.notAnalyzed.push(
    'Not estimated: group analytics add-on, data pipelines/destinations, AI observability, logs, data warehouse rows and other PostHog products.',
  );
  return out;
}

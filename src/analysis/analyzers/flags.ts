import { DOCS, LOCAL_EVAL_POLLS_PER_INSTANCE_PER_MONTH, WEB_LIB, isServerLib } from '../../posthog-facts.js';
import { count } from '../../report/format.js';
import type { AnalysisContext, AnalyzerOutput } from '../context.js';
import { emptyOutput } from '../context.js';
import { fractionOf } from '../costs.js';
import type { Driver, Fix, Snippet } from '../model.js';
import { ingestionHost, marketingPreamble, marketingScope } from '../snippets.js';

const STALE_DAYS = 30;

export function analyzeFlags(ctx: AnalysisContext): AnalyzerOutput {
  const out = emptyOutput();
  const flags = ctx.snap.flags;
  const defs = flags?.definitions ?? [];
  const active = defs.filter((d) => d.active);
  const requests = ctx.project.flagRequests;

  const blockers = active.filter((d) => d.ensureExperienceContinuity || d.usesStaticCohort || d.usesIsNotSet);
  const now = Date.parse(ctx.snap.generatedAt) || Date.now();
  const stale = active.filter((d) => d.lastCalledAt === null || now - Date.parse(d.lastCalledAt) > STALE_DAYS * 86_400_000);

  if (requests === null) {
    out.notAnalyzed.push(
      'Feature flag requests: request volume comes from the billing API (billing:read) or orgUsage in a snapshot; $feature_flag_called events do not measure it.',
    );
    if (active.length > 0) out.findings.push({ level: 'info', text: `${active.length} active feature flags.` });
    return out;
  }
  if (requests <= 0) return out;

  const byEvent = (name: string): number => ctx.snap.events?.byEvent.find((e) => e.event === name)?.count ?? 0;
  const identityRows = ctx.snap.events?.identity ?? [];
  const webIdentity = identityRows.length
    ? identityRows.filter((r) => r.lib === WEB_LIB && (r.event === '$identify' || r.event === '$groupidentify')).reduce((s, r) => s + r.count, 0)
    : byEvent('$identify') + byEvent('$groupidentify');
  const pageviews = ctx.monthly(byEvent('$pageview'));
  // posthog-js requests flags on page load, identify and group: about one request per page load plus those calls.
  const clientEstimate = pageviews + ctx.monthly(webIdentity);
  const beyondClient = Math.max(0, requests - clientEstimate);

  const called = flags?.calledByLib ?? [];
  const serverCalled = called.filter((r) => isServerLib(r.lib));
  const remoteCalls = serverCalled.filter((r) => r.locallyEvaluated === 'false').reduce((s, r) => s + r.count, 0);
  const localCalls = serverCalled.filter((r) => r.locallyEvaluated === 'true').reduce((s, r) => s + r.count, 0);
  const serverLibs = [...new Set(serverCalled.filter((r) => r.count > 0).map((r) => r.lib ?? ''))].filter(Boolean);

  const perPageview = pageviews > 0 ? requests / pageviews : null;
  const driver: Driver = {
    id: 'flags:all',
    title: 'Feature flag requests',
    product: 'feature_flags',
    units: requests,
    unitLabel: 'requests',
    costUsd: ctx.allocate('flagRequests', requests),
    shareOfProduct: ctx.org.flagRequests ? requests / ctx.org.flagRequests : null,
    detail: `${count(requests)} /flags requests/mo${perPageview !== null ? ` (${perPageview.toFixed(1)} per pageview)` : ''}.${active.length > 0 ? ` Each request evaluates your ${active.length} active flags; you pay per request, not per flag.` : ''}`,
    evidence: [],
    fixIds: [],
  };
  out.drivers.push(driver);
  if (called.length > 0) {
    driver.evidence.push({
      title: '$feature_flag_called by SDK',
      columns: ['SDK', 'locally_evaluated', 'Calls/mo', 'Distinct flags'],
      rows: called.slice(0, 8).map((r) => [r.lib ?? '(unknown)', r.locallyEvaluated ?? 'n/a', count(ctx.monthly(r.count)), r.flags ?? 'n/a']),
      note: '$feature_flag_called events are not billed and are deduplicated by SDKs, so they understate flag checks.',
    });
  }

  // Server-side checks without local evaluation.
  if (remoteCalls > 0 && remoteCalls >= localCalls && beyondClient / requests >= 0.2) {
    const polling = ctx.serverInstances * LOCAL_EVAL_POLLS_PER_INSTANCE_PER_MONTH;
    const serverDriver: Driver = {
      id: 'flags:server-remote',
      title: 'Server-side flag checks without local evaluation',
      product: 'feature_flags',
      units: beyondClient,
      unitLabel: 'requests',
      costUsd: ctx.allocate('flagRequests', beyondClient),
      shareOfProduct: beyondClient / requests,
      detail: `About ${count(beyondClient)} requests/mo are beyond ~1 per page load. ${serverLibs.join(', ')} sent ${count(ctx.monthly(remoteCalls))} $feature_flag_called events with locally_evaluated=false: each server-side check is a billable request.`,
      evidence: [],
      fixIds: [],
    };
    out.drivers.push(serverDriver);
    const fix: Fix = {
      id: 'flags-local-evaluation',
      title: `Evaluate flags locally in ${serverLibs.join(', ') || 'your server SDK'}`,
      kind: 'no-regret',
      products: ['feature_flags'],
      effects: [{ key: 'flagRequests', removeFraction: fractionOf(beyondClient, ctx.org.flagRequests), addUnits: polling }],
      assumption: `The ${count(beyondClient)} requests/mo beyond ~1 per page load are server-side checks; local evaluation replaces them with background polling: ${ctx.serverInstances} always-on server instance${ctx.serverInstances === 1 ? '' : 's'} (--server-instances) × 86,400 polls/month (every 30s; 1 request per unchanged poll with an ETag-capable SDK) = ${count(polling)} requests/mo.${blockers.length > 0 ? ` ${blockers.length} flag(s) can't be evaluated locally and will still call /flags.` : ''}`,
      youLose:
        'Nothing functional: flag changes reach servers within the polling interval (30s by default). You must pass the person/group properties your release conditions use.',
      steps: [
        'Create a project secret API key with the feature_flag:read scope ("Local feature flag evaluation" preset) and keep it server-side only.',
        'Use one long-lived client per process (not one per request) so definitions are cached and polled in the background.',
        'Use an SDK that sends ETags (posthog-node 5.17.2+, posthog-python 7.13.0+, posthog-go 1.12.2+, posthog-ruby 3.4.0+, posthog-php 3.7.3+): unchanged polls then cost 1 request instead of 10.',
        "Don't use local evaluation in edge/Lambda functions: each cold start initializes a client and polls again.",
        ...(blockers.length > 0
          ? [`These flags can't be evaluated locally (experience continuity, static cohorts or is_not_set): ${blockers.slice(0, 6).map((b) => b.key).join(', ')}.`]
          : []),
      ],
      snippets: localEvalSnippets(serverLibs, snippetHost(ctx)),
      initOptions: [],
      docs: [
        { title: 'Local evaluation', url: DOCS.localEvaluation },
        { title: 'Reducing local evaluation costs', url: `${DOCS.flagsCuttingCosts}#reducing-local-evaluation-costs` },
      ],
      evidence: `${count(ctx.monthly(remoteCalls))} server-side flag checks/mo evaluated remotely.`,
    };
    out.fixes.push(fix);
    serverDriver.fixIds.push(fix.id);
    driver.fixIds.push(fix.id);
  } else if (localCalls > remoteCalls && beyondClient / requests >= 0.2) {
    const fix: Fix = {
      id: 'flags-polling-interval',
      title: 'Poll flag definitions every 5 minutes instead of every 30 seconds',
      kind: 'trade-off',
      products: ['feature_flags'],
      effects: [{ key: 'flagRequests', removeFraction: fractionOf(beyondClient * 0.9, ctx.org.flagRequests) }],
      assumption: `Your servers already evaluate locally (${count(ctx.monthly(localCalls))} locally evaluated checks/mo), so the ${count(beyondClient)} requests/mo beyond ~1 per page load are most likely definition polls; polling 10× less often cuts them by 90%.`,
      youLose: 'Flag changes take up to 5 minutes (instead of 30 seconds) to reach your servers.',
      steps: [
        'Make sure your SDK sends ETags (posthog-node 5.17.2+, posthog-python 7.13.0+): unchanged polls then cost 1 request instead of 10.',
        'Many instances? Share definitions through an external cache so only one instance polls.',
      ],
      snippets: pollingSnippets(serverLibs, snippetHost(ctx)),
      initOptions: [],
      docs: [{ title: 'Reducing local evaluation costs', url: `${DOCS.flagsCuttingCosts}#reducing-local-evaluation-costs` }],
      evidence: `${count(beyondClient)} requests/mo beyond the browser estimate.`,
    };
    out.fixes.push(fix);
    driver.fixIds.push(fix.id);
  }

  // Browser requests on marketing pages.
  const pages = ctx.snap.events?.byPage ?? [];
  const marketingPageviews = pages.filter((p) => ctx.classify(p.host, p.path) === 'marketing').reduce((s, p) => s + p.pageviews, 0);
  const scope = marketingScope(ctx);
  const preamble = marketingPreamble(scope);
  const m = ctx.monthly(marketingPageviews);
  if (preamble && m > 0 && m / requests >= 0.03) {
    const fix: Fix = {
      id: 'flags-marketing-first-load',
      title: 'Skip flag evaluation on marketing page loads',
      kind: 'trade-off',
      products: ['feature_flags'],
      effects: [{ key: 'flagRequests', removeFraction: fractionOf(m, ctx.org.flagRequests) }],
      assumption: `About one billable /flags request per marketing page load (${count(m)}/mo, estimated from marketing pageviews) stops being charged: with advanced_disable_feature_flags_on_first_load the SDK still calls /flags but doesn't evaluate flags, and PostHog doesn't bill that request.`,
      youLose:
        "Feature flags and experiments on marketing pages until the visitor is identified or you call posthog.reloadFeatureFlags(). Don't use it if you A/B test landing pages; if you show surveys there, use advanced_only_evaluate_survey_feature_flags instead.",
      steps: [
        'Server-rendered pages: evaluate flags on the server (with local evaluation) and bootstrap posthog-js, so the browser never needs the first-load request.',
      ],
      snippets: [bootstrapSnippet()],
      initOptions: [
        {
          key: 'advanced_disable_feature_flags_on_first_load',
          value: 'isMarketingPage',
          comment: 'no billable /flags request on marketing page loads',
          preamble: [preamble],
        },
      ],
      docs: [
        { title: 'Reducing client-side feature flag requests', url: `${DOCS.flagsCuttingCosts}#reducing-client-side-feature-flag-requests` },
        { title: 'Bootstrapping flags', url: DOCS.bootstrapping },
      ],
      evidence: `${count(m)} marketing page loads/mo request flags.`,
    };
    out.fixes.push(fix);
    driver.fixIds.push(fix.id);
  }

  if (blockers.length > 0 && !out.fixes.some((f) => f.id === 'flags-local-evaluation')) {
    out.findings.push({
      level: 'info',
      text: `${blockers.length} active flag(s) can't be evaluated locally (experience continuity, static cohorts or is_not_set): ${blockers.slice(0, 6).map((b) => b.key).join(', ')}.`,
    });
  }
  if (stale.length > 0) {
    out.findings.push({
      level: 'info',
      text: `${stale.length} active flag(s) weren't called in the last ${STALE_DAYS} days (${stale.slice(0, 6).map((s) => s.key).join(', ')}${stale.length > 6 ? '…' : ''}). Archiving them doesn't change the per-request price, but browser requests only stop being billable when they evaluate no active flags.`,
    });
  }
  if (perPageview !== null && perPageview > 3 && !out.fixes.some((f) => f.id.startsWith('flags-local') || f.id.startsWith('flags-polling'))) {
    out.findings.push({
      level: 'warning',
      text: `${perPageview.toFixed(1)} flag requests per pageview is high. Look for posthog.reloadFeatureFlags() in loops, identify()/group() on every route change, or servers checking flags without local evaluation.`,
    });
  }
  return out;
}

/** Ingestion host for server SDK snippets: the user's region when known, else US with an EU hint. */
function snippetHost(ctx: AnalysisContext): { host: string; hint: string } {
  if (ctx.hasRealAppHost()) return { host: ingestionHost(ctx.appHost()), hint: '' };
  return { host: 'https://us.i.posthog.com', hint: ' // EU Cloud: https://eu.i.posthog.com' };
}

function localEvalSnippets(libs: readonly string[], ingest: { host: string; hint: string }): Snippet[] {
  const snippets: Snippet[] = [];
  if (libs.includes('posthog-python')) {
    snippets.push({
      title: 'posthog-python',
      language: 'python',
      code: [
        'import os',
        'from posthog import Posthog',
        '',
        '# One client per process. secret_key needs posthog 7.22.1+ (older versions: personal_api_key).',
        'posthog = Posthog(',
        '    "<ph_project_token>",',
        `    host="${ingest.host}",${ingest.hint.replace('//', '#')}`,
        '    secret_key=os.environ["POSTHOG_FLAGS_SECRET_KEY"],  # project secret API key, feature_flag:read',
        '    poll_interval=30,  # seconds; raise it to poll less often',
        ')',
        '',
        'flags = posthog.evaluate_flags(',
        '    user.id,',
        '    person_properties={"plan": user.plan},  # pass what your release conditions use',
        ')',
        'if flags.get_flag("new-billing"):',
        '    ...',
      ].join('\n'),
    });
  }
  if (libs.length === 0 || libs.some((l) => l !== 'posthog-python')) {
    snippets.unshift({
      title: 'posthog-node',
      language: 'js',
      code: [
        "import { PostHog } from 'posthog-node'",
        '',
        '// One client per process, not per request. secretKey needs posthog-node 5.40.0+ (older: personalApiKey).',
        'export const posthog = new PostHog(process.env.POSTHOG_PROJECT_TOKEN, {',
        `  host: '${ingest.host}',${ingest.hint}`,
        '  secretKey: process.env.POSTHOG_FLAGS_SECRET_KEY, // project secret API key with feature_flag:read',
        '  featureFlagsPollingInterval: 30000, // ms; raise it to poll less often',
        '})',
        '',
        'const flags = await posthog.evaluateFlags(user.id, {',
        '  personProperties: { plan: user.plan }, // pass what your release conditions use',
        '})',
        "if (flags.getFlag('new-billing')) {",
        '  // ...',
        '}',
      ].join('\n'),
    });
  }
  return snippets;
}

function pollingSnippets(libs: readonly string[], ingest: { host: string; hint: string }): Snippet[] {
  const snippets: Snippet[] = [];
  if (libs.includes('posthog-python')) {
    snippets.push({ title: 'posthog-python', language: 'python', code: `posthog = Posthog("<ph_project_token>", host="${ingest.host}", secret_key=SECRET, poll_interval=300)` });
  }
  if (libs.length === 0 || libs.some((l) => l !== 'posthog-python')) {
    snippets.unshift({
      title: 'posthog-node',
      language: 'js',
      code: `const posthog = new PostHog(token, { host: '${ingest.host}', secretKey, featureFlagsPollingInterval: 300000 }) // 5 minutes`,
    });
  }
  return snippets;
}

function bootstrapSnippet(): Snippet {
  return {
    title: 'Server-rendered pages: bootstrap flags instead of fetching them on load',
    language: 'js',
    code: [
      '// Server (posthog-node with local evaluation): evaluate once per page request',
      'const featureFlags = await posthog.getAllFlags(distinctId, { personProperties: { plan: user.plan } })',
      '',
      '// Browser: start with those values',
      "posthog.init('<ph_project_token>', {",
      '  bootstrap: { distinctID: distinctId, featureFlags },',
      '  advanced_disable_feature_flags_on_first_load: true,',
      '})',
    ].join('\n'),
  };
}

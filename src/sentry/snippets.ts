/**
 * Paste-ready Sentry.init snippets (@sentry/browser, @sentry/node and the framework SDKs share
 * these options). Never contains a real DSN: the placeholder '<sentry_dsn>' stands in for it.
 */
import type { Snippet } from '../analysis/model.js';

export const DSN_PLACEHOLDER = '<sentry_dsn>';

export interface DropTarget {
  /** Message to match (the issue title, e.g. "TypeError: Load failed"). */
  match: string;
  /** Short comment, e.g. "web-app · ignored · 610K/mo". */
  note: string;
}

/** Issue title → the substring ignoreErrors/beforeSend should match (Sentry may add a trailing ellipsis). */
export function matchText(title: string): string {
  return title.replace(/\s+/g, ' ').replace(/(\.\.\.|…)$/, '').trim().slice(0, 200);
}

/** Control characters and line separators become spaces, so a title can't break out of a line. */
function oneLine(s: string): string {
  return [...s].map((ch) => (ch.charCodeAt(0) < 32 || ch === '\u2028' || ch === '\u2029' ? ' ' : ch)).join('');
}
const lit = (s: string): string => `'${oneLine(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const comment = (s: string): string => oneLine(s);

export function ignoreErrorsSnippet(targets: readonly DropTarget[]): Snippet {
  const lines = [
    '// Review before shipping. Errors matching these strings are dropped by the SDK, never sent to',
    "// Sentry and never billed. You won't see them in Sentry at all. Needs a redeploy.",
    'Sentry.init({',
    `  dsn: ${lit(DSN_PLACEHOLDER)},`,
    '  ignoreErrors: [',
    ...targets.map((t) => `    ${lit(t.match)}, // ${comment(t.note)}`),
    '  ],',
    '});',
  ];
  return { title: 'Sentry.init: ignoreErrors', language: 'js', code: lines.join('\n') };
}

export function beforeSendSnippet(targets: readonly DropTarget[]): Snippet {
  const lines = [
    '// Review before shipping. Same idea as ignoreErrors, but you can add conditions (release,',
    '// environment, URL) before dropping. Returning null drops the event in the SDK: not sent, not billed.',
    'const FRUMO_DROP = [',
    ...targets.map((t) => `  ${lit(t.match)}, // ${comment(t.note)}`),
    '];',
    '',
    'Sentry.init({',
    `  dsn: ${lit(DSN_PLACEHOLDER)},`,
    '  beforeSend(event) {',
    "    const texts = [event.message || ''];",
    '    for (const ex of (event.exception && event.exception.values) || []) {',
    "      texts.push((ex.type || '') + ': ' + (ex.value || ''), ex.value || '');",
    '    }',
    '    if (texts.some((t) => FRUMO_DROP.some((m) => t.includes(m)))) return null;',
    '    return event;',
    '  },',
    '});',
  ];
  return { title: 'Sentry.init: beforeSend filter', language: 'js', code: lines.join('\n') };
}

export function tracesSampleRateSnippet(rate: number): Snippet {
  const lines = [
    '// Review before shipping. Sampling hides some traces (and the spans in them); needs a redeploy.',
    '// Start by halving the rate you use today; keep a higher rate for the routes you care about.',
    'Sentry.init({',
    `  dsn: ${lit(DSN_PLACEHOLDER)},`,
    `  tracesSampleRate: ${rate},`,
    '});',
  ];
  return { title: 'Sentry.init: tracesSampleRate', language: 'js', code: lines.join('\n') };
}

export function errorSampleRateSnippet(rate: number): Snippet {
  const lines = [
    '// Review before shipping. sampleRate drops a random share of ALL errors, including rare',
    '// and new ones, and skews event counts. Prefer fixing or filtering noisy issues first. Needs a redeploy.',
    'Sentry.init({',
    `  dsn: ${lit(DSN_PLACEHOLDER)},`,
    `  sampleRate: ${rate},`,
    '});',
  ];
  return { title: 'Sentry.init: sampleRate (errors)', language: 'js', code: lines.join('\n') };
}

/**
 * The waitlist line printed at the end of the terminal summary and the HTML report.
 * It is plain text and a plain link: frumo never requests this URL itself (no telemetry,
 * no pixel, no auto-open). Clicks are counted only by the `?ref=` value in the link.
 * Hide it with --no-footer. JSON output never includes it.
 */

/** Waitlist origin + path. The only place this URL may appear in src/ (a repo-rules test checks it). */
export const WAITLIST_URL = 'https://frumo.marianoventures.com/';

/** Where the link was shown, sent as `?ref=` so useful runs can be counted without tracking. */
export const WAITLIST_REFS = { cli: 'cli', report: 'report' } as const;

export type WaitlistSurface = keyof typeof WAITLIST_REFS;

export const WAITLIST_TEXT = 'Found this useful? Join the frumo waitlist:';

export function waitlistUrl(surface: WaitlistSurface): string {
  return `${WAITLIST_URL}?ref=${WAITLIST_REFS[surface]}`;
}

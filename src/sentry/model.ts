/** The `frumo sentry` report model (JSON schema "frumo.sentry-report/v1"). */
import type { FixKind, Snippet } from '../analysis/model.js';
import type { SentryBilledCategory, SentryPlan } from '../pricing/types.js';
import type { SentrySourceKind } from './snapshot.js';

export type SentryVolumes = Record<SentryBilledCategory, number | null>;

/** A change in monthly accepted volume caused by a fix. Absolute removals apply before fractions. */
export interface SentryEffect {
  category: SentryBilledCategory;
  removeUnits?: number;
  removeFraction?: number;
}

export interface SentryCostLine {
  category: SentryBilledCategory;
  label: string;
  unitPlural: string;
  /** Accepted (billed) units per 30-day month; null = unknown. */
  accepted: number | null;
  /** Dropped before billing per month: inbound filters, rate limits / spike protection, other outcomes. */
  filtered: number;
  rateLimited: number;
  otherDropped: number;
  included: number;
  usd: number | null;
}

export interface SentryFix {
  id: string;
  title: string;
  kind: FixKind;
  effects: SentryEffect[];
  evidence: string;
  assumption: string;
  youLose: string;
  steps: string[];
  snippets: Snippet[];
  docs: Array<{ title: string; url: string }>;
  /** Monthly saving if only this fix is applied; null = frumo can't measure the volume it removes. */
  savingUsd: number | null;
}

export interface SentryIssueRow {
  rank: number;
  id: string;
  shortId: string | null;
  title: string;
  culprit: string | null;
  projectSlug: string | null;
  status: string;
  /** Events per 30-day month. */
  eventsPerMonth: number;
  /** Error bill with this issue's events removed, subtracted from today's (PAYG bands at your volume). */
  estUsd: number | null;
  /** Ignored/archived but still sending events (they still count toward quota). */
  ignoredButBilled: boolean;
  /** Which fix covers it, if any. */
  fixId: string | null;
}

export interface SentryProjectRow {
  id: string;
  slug: string;
  name: string | null;
  platform: string | null;
  accepted: SentryVolumes;
  /** Share of the estimated bill at average rates. */
  costUsd: number | null;
  checked: boolean;
  filtersOff: string[];
  keysWithoutRateLimit: number | null;
}

export interface SentryDriver {
  title: string;
  category: SentryBilledCategory;
  units: number;
  unitPlural: string;
  costUsd: number | null;
}

export interface SentryAuditResult {
  schema: 'frumo.sentry-report/v1';
  tool: { name: 'frumo'; version: string };
  generatedAt: string;
  input: {
    sourceKind: SentrySourceKind;
    label: string | null;
    fictional: boolean;
    host: string | null;
    org: string;
    periodDays: number;
    periodStart: string | null;
    periodEnd: string | null;
    plan: SentryPlan;
  };
  pricing: { name: string; sources: readonly string[]; retrieved: string; plan: SentryPlan };
  costs: { lines: SentryCostLine[]; totalUsd: number; anyKnown: boolean };
  savings: { allUsd: number; noRegretUsd: number; allPct: number; noRegretPct: number };
  drivers: SentryDriver[];
  projects: SentryProjectRow[];
  issues: SentryIssueRow[];
  fixes: SentryFix[];
  findings: Array<{ level: 'info' | 'warning'; text: string }>;
  notEstimated: string[];
  notes: string[];
  disclaimer: string;
}

import { AnalysisContext } from '../src/analysis/context.js';
import type { AnalysisOptions, AnalyzerOutput } from '../src/analysis/context.js';
import { runAnalysis } from '../src/analysis/index.js';
import { SNAPSHOT_SCHEMA, emptyUsage } from '../src/snapshot.js';
import type { EventsData, ProjectUsage, Snapshot, Usage } from '../src/snapshot.js';
import { readDemoSnapshot } from '../src/sources/file.js';

export const NOW = new Date('2026-11-18T12:00:00.000Z');

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: NOW.toISOString(),
    source: { kind: 'file', host: null, toolVersion: 'test', fictional: false, label: null },
    project: { id: '1', name: 'Test project' },
    period: { days: 30, start: null, end: null },
    orgUsage: null,
    projectSettings: null,
    events: null,
    replay: null,
    flags: null,
    billing: null,
    notes: [],
    ...overrides,
  };
}

export function events(partial: Partial<Omit<EventsData, 'totals'>> & { totals?: Partial<EventsData['totals']> } = {}): EventsData {
  const byEvent = partial.byEvent ?? [];
  const billable = partial.totals?.billable ?? byEvent.reduce((s, e) => s + e.count, 0);
  return {
    byEvent,
    byLib: partial.byLib ?? null,
    byHost: partial.byHost ?? null,
    byPage: partial.byPage ?? null,
    autocaptureDomEvents: partial.autocaptureDomEvents ?? null,
    autocaptureElements: partial.autocaptureElements ?? null,
    identity: partial.identity ?? null,
    bots: partial.bots ?? null,
    serverEvents: partial.serverEvents ?? null,
    totals: {
      all: partial.totals?.all ?? null,
      billable,
      billableIdentified: partial.totals?.billableIdentified ?? null,
      unidentifiedPersonEvents: partial.totals?.unidentifiedPersonEvents ?? null,
    },
  };
}

export function usage(partial: Partial<Usage>): Usage {
  return { ...emptyUsage(), ...partial };
}

export function project(projectId: string, partial: Partial<Usage>, extra: Partial<ProjectUsage> = {}): ProjectUsage {
  return { projectId, name: null, audited: false, usage: usage(partial), ...extra };
}

export const OPTIONS: AnalysisOptions = { toolVersion: 'test', now: NOW };

export function context(snap: Snapshot, options: Partial<AnalysisOptions> = {}): AnalysisContext {
  return new AnalysisContext(snap, { ...OPTIONS, ...options });
}

export function run(analyzer: (ctx: AnalysisContext) => AnalyzerOutput, snap: Snapshot, options: Partial<AnalysisOptions> = {}): AnalyzerOutput {
  return analyzer(context(snap, options));
}

export function analyze(snap: Snapshot, options: Partial<AnalysisOptions> = {}) {
  return runAnalysis(snap, { ...OPTIONS, ...options });
}

export async function demo(): Promise<Snapshot> {
  return readDemoSnapshot();
}

/** A fetch stand-in that records calls and answers from a route table. */
export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export function mockFetch(route: Route): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return route(call);
  };
  return { fetch: fn as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const noSleep = async (): Promise<void> => undefined;

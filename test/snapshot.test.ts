import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBillableEvent, isBotUserAgent } from '../src/posthog-facts.js';
import { SNAPSHOT_SCHEMA, parseSnapshot } from '../src/snapshot.js';
import { ValidationError } from '../src/util/validate.js';
import { demo, snapshot } from './helpers.js';

describe('snapshot format', () => {
  it('round-trips the demo snapshot', async () => {
    const snap = await demo();
    expect(parseSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it('fills missing optional sections with null', () => {
    const parsed = parseSnapshot({ schema: SNAPSHOT_SCHEMA, period: { days: 7 } });
    expect(parsed.events).toBeNull();
    expect(parsed.replay).toBeNull();
    expect(parsed.orgUsage).toBeNull();
    expect(parsed.period.days).toBe(7);
    expect(parsed.source.kind).toBe('file');
  });

  it('rejects files that are not frumo snapshots', () => {
    expect(() => parseSnapshot({ hello: 'world' })).toThrow(/schema/);
    expect(() => parseSnapshot([])).toThrow(ValidationError);
    for (const schema of ['frumo.snapshot/v2', 'hogpost.snapshot/v2', 'frumo.report/v1', 42]) {
      expect(() => parseSnapshot({ schema, period: { days: 7 } }), String(schema)).toThrow(/expected "frumo\.snapshot\/v1"/);
    }
  });

  it('writes frumo.snapshot/v1 and still reads snapshots saved as hogpost.snapshot/v1', async () => {
    expect(SNAPSHOT_SCHEMA).toBe('frumo.snapshot/v1');
    const current = JSON.parse(JSON.stringify(await demo())) as Record<string, unknown>;
    const legacy = parseSnapshot({ ...current, schema: 'hogpost.snapshot/v1' });
    expect(legacy.schema, 'legacy snapshots are upgraded to the current schema id').toBe(SNAPSHOT_SCHEMA);
    expect(legacy).toEqual(parseSnapshot(current));
  });

  it('reports every invalid field with its path', () => {
    try {
      parseSnapshot({
        schema: SNAPSHOT_SCHEMA,
        period: { days: 0 },
        events: { totals: { billable: -1 }, byEvent: [{ event: 'x', count: 'many' }] },
        orgUsage: [{ name: 'no id', usage: { events: 5, rockets: 1 } }],
        billing: { limitsUsd: { teleport: 5 } },
      });
      expect.unreachable();
    } catch (error) {
      const issues = (error as ValidationError).issues.join('\n');
      expect(issues).toMatch(/period\.days/);
      expect(issues).toMatch(/events\.totals\.billable: expected a number >= 0/);
      expect(issues).toMatch(/events\.byEvent\[0\]\.count/);
      expect(issues).toMatch(/orgUsage\[0\]\.projectId: required/);
      expect(issues).toMatch(/orgUsage\[0\]\.usage\.rockets: unknown usage meter/);
      expect(issues).toMatch(/billing\.limitsUsd\.teleport/);
    }
  });

  it('accepts numeric project ids and keeps them as strings', () => {
    const parsed = parseSnapshot({ ...snapshot(), project: { id: 42, name: 'P' } });
    expect(parsed.project.id).toBe('42');
  });
});

describe('demo fixture', () => {
  it('is stored with the current schema id (regenerate with npm run fixture:demo)', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/demo-snapshot.json', import.meta.url), 'utf8')) as { schema?: unknown };
    expect(raw.schema).toBe(SNAPSHOT_SCHEMA);
  });

  it('is clearly fictional', async () => {
    const snap = await demo();
    expect(snap.source.fictional).toBe(true);
    expect(snap.source.kind).toBe('demo');
    expect(snap.source.label).toMatch(/fictional/);
    const hosts = (snap.events?.byHost ?? []).map((h) => h.host);
    for (const host of hosts) expect(host).toMatch(/\.example$|^localhost|vercel\.app$/);
  });

  it('is internally consistent', async () => {
    const snap = await demo();
    const ev = snap.events;
    if (!ev || !snap.replay || !snap.orgUsage) throw new Error('demo fixture is missing sections');
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

    const billableFromEvents = sum(ev.byEvent.filter((e) => isBillableEvent(e.event)).map((e) => e.count));
    expect(billableFromEvents).toBe(ev.totals.billable);
    expect(ev.totals.billableIdentified).toBeLessThanOrEqual(ev.totals.billable);
    expect(ev.totals.unidentifiedPersonEvents).toBeLessThanOrEqual(ev.totals.billableIdentified ?? 0);
    expect(sum((ev.byPage ?? []).map((p) => p.count))).toBeLessThanOrEqual(ev.totals.billable);
    expect(sum((ev.byHost ?? []).map((p) => p.count))).toBe(sum((ev.byPage ?? []).map((p) => p.count)));
    expect(sum((ev.byLib ?? []).map((l) => l.count))).toBe(ev.totals.billable);

    const autocapture = ev.byEvent.find((e) => e.event === '$autocapture')?.count ?? 0;
    expect(sum((ev.byPage ?? []).map((p) => p.autocapture))).toBe(autocapture);
    for (const host of new Set((ev.autocaptureElements ?? []).map((e) => e.host))) {
      const elements = sum((ev.autocaptureElements ?? []).filter((e) => e.host === host).map((e) => e.count));
      const pages = sum((ev.byPage ?? []).filter((p) => p.host === host).map((p) => p.autocapture));
      expect(elements, String(host)).toBeLessThanOrEqual(pages);
    }
    for (const name of ['$identify', '$set', '$groupidentify']) {
      const identity = sum((ev.identity ?? []).filter((r) => r.event === name).map((r) => r.count));
      expect(identity, name).toBe(ev.byEvent.find((e) => e.event === name)?.count);
    }
    for (const row of ev.identity ?? []) expect(row.necessary).toBeLessThanOrEqual(row.count);
    for (const bot of ev.bots ?? []) expect(isBotUserAgent(bot.userAgent), bot.userAgent).toBe(true);

    const replay = snap.replay;
    expect(sum((replay.byFirstUrl ?? []).map((r) => r.count))).toBe(replay.recordings);
    expect(sum((replay.byFirstUrl ?? []).map((r) => r.under5s))).toBe(replay.durations?.under5s);
    const d = replay.durations;
    expect(d && d.under5s <= d.under10s && d.under10s <= d.under30s && d.under30s <= d.under60s).toBe(true);

    const audited = snap.orgUsage.find((p) => p.audited);
    expect(audited?.usage.events).toBe(ev.totals.billable);
    expect(audited?.usage.identifiedEvents).toBe(ev.totals.billableIdentified);
    expect(audited?.usage.recordings).toBe(replay.recordings);
  });

  it('has about 8M events per month as described in the README', async () => {
    const snap = await demo();
    expect(snap.period.days).toBe(30);
    expect(snap.events?.totals.billable).toBeGreaterThan(7_500_000);
    expect(snap.events?.totals.billable).toBeLessThan(8_500_000);
  });
});

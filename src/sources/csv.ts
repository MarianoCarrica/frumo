/**
 * The simple offline path: a CSV of event counts.
 *
 *   event,count[,identified]
 *   $autocapture,3620000,2050000
 *   $pageview,1240000
 *
 * Header optional; comma, semicolon or tab separated; quoted fields allowed. Counts are treated
 * as covering --days days (default 30). Export it from PostHog's SQL editor with e.g.
 *   SELECT event, count() AS count FROM events WHERE timestamp >= now() - INTERVAL 30 DAY GROUP BY event
 */
import { isBillableEvent } from '../posthog-facts.js';
import { SNAPSHOT_SCHEMA } from '../snapshot.js';
import type { EventCount, Snapshot } from '../snapshot.js';
import { ValidationError } from '../util/validate.js';

const MAX_ROWS = 100_000;
const EVENT_HEADERS = ['event', 'event name', 'event_name', 'name', 'events.event'];
const COUNT_HEADERS = ['count', 'count()', 'total', 'events', 'volume', 'event count', 'event_count'];
const IDENTIFIED_HEADERS = ['identified', 'identified events', 'identified_events', 'person events', 'person_events'];

export function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (c === delimiter) {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

function parseCount(raw: string): number | null {
  const cleaned = raw.replace(/[\s_,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const BOM = String.fromCharCode(0xfeff);
const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

export function parseEventCountsCsv(text: string): EventCount[] {
  const lines = stripBom(text).split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  if (lines.length === 0) throw new ValidationError('CSV file', ['the file is empty']);
  if (lines.length > MAX_ROWS) throw new ValidationError('CSV file', [`too many rows (${lines.length} > ${MAX_ROWS})`]);
  const first = lines[0] ?? '';
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';

  let eventCol = 0;
  let countCol = 1;
  let identCol: number | null = null;
  let startRow = 0;
  const header = parseCsvLine(first, delimiter).map((h) => h.toLowerCase());
  const looksLikeHeader = header.length >= 2 && parseCount(header[1] ?? '') === null;
  if (looksLikeHeader) {
    startRow = 1;
    const find = (names: string[]) => header.findIndex((h) => names.includes(h));
    const e = find(EVENT_HEADERS);
    const c = find(COUNT_HEADERS);
    const id = find(IDENTIFIED_HEADERS);
    if (e >= 0) eventCol = e;
    if (c >= 0) countCol = c;
    if (id >= 0) identCol = id;
    if (e < 0 || c < 0) {
      if (header.length < 2) throw new ValidationError('CSV file', ['need at least two columns: event name and count']);
    }
  } else if (header.length >= 3 && parseCount(header[2] ?? '') !== null) {
    identCol = 2;
  }

  const issues: string[] = [];
  const merged = new Map<string, EventCount>();
  for (let i = startRow; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i] ?? '', delimiter);
    const event = cells[eventCol] ?? '';
    const count = parseCount(cells[countCol] ?? '');
    if (event === '') {
      issues.push(`line ${i + 1}: missing event name`);
      continue;
    }
    if (count === null) {
      issues.push(`line ${i + 1}: count "${cells[countCol] ?? ''}" is not a number`);
      continue;
    }
    let identified: number | null = null;
    if (identCol !== null) {
      const raw = cells[identCol] ?? '';
      if (raw !== '') {
        identified = parseCount(raw);
        if (identified === null) issues.push(`line ${i + 1}: identified "${raw}" is not a number`);
        else if (identified > count) issues.push(`line ${i + 1}: identified (${identified}) is larger than count (${count})`);
      }
    }
    const previous = merged.get(event);
    merged.set(event, {
      event,
      count: (previous?.count ?? 0) + count,
      identified: identified === null && (previous === undefined || previous.identified === null) ? null : (previous?.identified ?? 0) + (identified ?? 0),
    });
    if (issues.length > 20) break;
  }
  if (issues.length > 0) throw new ValidationError('CSV file', issues);
  if (merged.size === 0) throw new ValidationError('CSV file', ['no data rows']);
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

export function snapshotFromEventCounts(rows: EventCount[], options: { days: number; toolVersion: string; label: string; now?: Date }): Snapshot {
  const billable = rows.filter((r) => isBillableEvent(r.event));
  const hasIdentified = billable.length > 0 && billable.every((r) => r.identified !== null);
  const now = options.now ?? new Date();
  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: now.toISOString(),
    source: { kind: 'csv', host: null, toolVersion: options.toolVersion, fictional: false, label: options.label },
    project: { id: null, name: null },
    period: { days: options.days, start: null, end: null },
    orgUsage: null,
    projectSettings: null,
    events: {
      totals: {
        all: rows.reduce((s, r) => s + r.count, 0),
        billable: billable.reduce((s, r) => s + r.count, 0),
        billableIdentified: hasIdentified ? billable.reduce((s, r) => s + (r.identified ?? 0), 0) : null,
        unidentifiedPersonEvents: null,
      },
      byEvent: rows,
      byLib: null,
      byHost: null,
      byPage: null,
      autocaptureDomEvents: null,
      autocaptureElements: null,
      identity: null,
      bots: null,
      serverEvents: null,
    },
    replay: null,
    flags: null,
    billing: null,
    notes: [
      `Event counts from a CSV file, treated as covering ${options.days} days.${hasIdentified ? '' : ' No identified column, so identified events are unknown: person-profile costs are not estimated.'}`,
    ],
  };
}

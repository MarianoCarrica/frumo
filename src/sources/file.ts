import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot } from '../snapshot.js';
import type { Snapshot } from '../snapshot.js';
import { UsageError } from '../util/errors.js';
import { parseEventCountsCsv, snapshotFromEventCounts } from './csv.js';

const MAX_BYTES = 50 * 1024 * 1024;

/** Reads a snapshot (.json) or an event-count CSV (.csv/.tsv, or anything that isn't JSON). */
export async function readInputFile(path: string, options: { days: number; toolVersion: string; now?: Date }): Promise<Snapshot> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new UsageError(`Can't read --from file "${path}" (does it exist?).`);
  }
  if (size > MAX_BYTES) throw new UsageError(`--from file is larger than ${MAX_BYTES / 1024 / 1024} MB.`);
  const text = await readFile(path, 'utf8');
  const ext = extname(path).toLowerCase();
  const isJson = ext === '.json' || (ext !== '.csv' && ext !== '.tsv' && text.trimStart().startsWith('{'));
  if (!isJson) {
    const rows = parseEventCountsCsv(text);
    return snapshotFromEventCounts(rows, { ...options, label: basename(path) });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`--from file "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseSnapshot(json, `Snapshot "${basename(path)}"`);
}

/** Path of the bundled demo snapshot (works from src/ and from dist/). */
export function demoSnapshotPath(): string {
  return fileURLToPath(new URL('../../fixtures/demo-snapshot.json', import.meta.url));
}

export async function readDemoSnapshot(): Promise<Snapshot> {
  const text = await readFile(demoSnapshotPath(), 'utf8');
  return parseSnapshot(JSON.parse(text) as unknown, 'Demo snapshot');
}

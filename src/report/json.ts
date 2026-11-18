import type { AuditResult } from '../analysis/model.js';

/** Machine-readable report (schema "hogpost.report/v1"), pretty-printed. */
export function renderJson(result: AuditResult): string {
  return `${JSON.stringify(result, (_key, value: unknown) => (typeof value === 'number' && !Number.isFinite(value) ? null : value), 2)}\n`;
}

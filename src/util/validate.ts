/**
 * Tiny, dependency-free validation helpers for untrusted JSON (snapshots, pricing overrides,
 * API responses). Every helper records a readable issue with a JSON path instead of throwing,
 * so users get all problems at once.
 */

export class ValidationError extends Error {
  readonly issues: readonly string[];
  constructor(what: string, issues: readonly string[]) {
    const shown = issues.slice(0, 12);
    const more = issues.length > shown.length ? `\n  …and ${issues.length - shown.length} more` : '';
    super(`${what} is invalid:\n  - ${shown.join('\n  - ')}${more}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Array.isArray narrows to any[]; this narrows to unknown[] so elements still need checking. */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class Issues {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path || '(root)'}: ${message}`);
  }

  get ok(): boolean {
    return this.list.length === 0;
  }

  throwIfAny(what: string): void {
    if (!this.ok) throw new ValidationError(what, this.list);
  }

  record(value: unknown, path: string): Record<string, unknown> | null {
    if (isRecord(value)) return value;
    this.add(path, `expected an object, got ${describe(value)}`);
    return null;
  }

  optionalRecord(value: unknown, path: string): Record<string, unknown> | null {
    if (value === undefined || value === null) return null;
    return this.record(value, path);
  }

  array(value: unknown, path: string, maxLength = 100_000): unknown[] | null {
    if (!isArray(value)) {
      this.add(path, `expected an array, got ${describe(value)}`);
      return null;
    }
    if (value.length > maxLength) {
      this.add(path, `array too long (${value.length} > ${maxLength})`);
      return null;
    }
    return value;
  }

  optionalArray(value: unknown, path: string, maxLength = 100_000): unknown[] | null {
    if (value === undefined || value === null) return null;
    return this.array(value, path, maxLength);
  }

  string(value: unknown, path: string, maxLength = 2_000): string | null {
    if (typeof value !== 'string') {
      this.add(path, `expected a string, got ${describe(value)}`);
      return null;
    }
    if (value.length > maxLength) {
      this.add(path, `string too long (${value.length} > ${maxLength} characters)`);
      return null;
    }
    return value;
  }

  /** Accepts a string or null/undefined (→ null). */
  nullableString(value: unknown, path: string, maxLength = 2_000): string | null {
    if (value === undefined || value === null) return null;
    return this.string(value, path, maxLength);
  }

  /** Non-negative finite number (counts, prices). */
  count(value: unknown, path: string): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.add(path, `expected a finite number, got ${describe(value)}`);
      return null;
    }
    if (value < 0) {
      this.add(path, `expected a number >= 0, got ${value}`);
      return null;
    }
    return value;
  }

  /** Non-negative number or null/undefined (→ null, meaning "unknown"). */
  nullableCount(value: unknown, path: string): number | null {
    if (value === undefined || value === null) return null;
    return this.count(value, path);
  }

  numberInRange(value: unknown, path: string, min: number, max: number): number | null {
    const n = this.count(value, path);
    if (n === null) return null;
    if (n < min || n > max) {
      this.add(path, `expected a number between ${min} and ${max}, got ${n}`);
      return null;
    }
    return n;
  }

  nullableBoolean(value: unknown, path: string): boolean | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') {
      this.add(path, `expected true/false, got ${describe(value)}`);
      return null;
    }
    return value;
  }
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)})`;
  return typeof value;
}

import { UsageError } from '../../util/errors.js';

export const DEFAULT_HOST = 'https://us.posthog.com';

/** Ingestion/asset hosts people often paste, mapped to the private API host. */
const API_HOST_FOR: Record<string, string> = {
  'us.i.posthog.com': 'https://us.posthog.com',
  'eu.i.posthog.com': 'https://eu.posthog.com',
  'app.posthog.com': 'https://us.posthog.com',
  'us-assets.i.posthog.com': 'https://us.posthog.com',
  'eu-assets.i.posthog.com': 'https://eu.posthog.com',
};

export interface NormalizedHost {
  /** Origin to call, e.g. https://eu.posthog.com (no trailing slash). */
  origin: string;
  notes: string[];
}

/**
 * Validates --host. The personal API key is sent to this origin, so it must be HTTPS
 * (http only for localhost or with --allow-http) and contain no credentials or paths.
 */
export function normalizeHost(input: string, options: { allowHttp?: boolean } = {}): NormalizedHost {
  const notes: string[] = [];
  const raw = input.trim();
  if (raw === '') throw new UsageError('--host is empty.');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`--host "${raw}" is not a valid URL. Example: --host https://eu.posthog.com`);
  }
  if (url.username || url.password) throw new UsageError('--host must not contain credentials. Put the key in EVENTSPEND_API_KEY.');
  if (url.search || url.hash) throw new UsageError('--host must not contain a query string or fragment.');
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UsageError(`--host should be just the origin (e.g. ${url.origin}), not a path like "${url.pathname}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError('--host must use https://');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !local && !options.allowHttp) {
    throw new UsageError(
      `Refusing to send your API key over plain HTTP to ${url.host}. Use https://, or pass --allow-http if this self-hosted instance really has no TLS.`,
    );
  }
  const mapped = API_HOST_FOR[url.hostname];
  if (mapped) {
    notes.push(`${url.hostname} is not the API host; using ${mapped} instead.`);
    return { origin: mapped, notes };
  }
  return { origin: url.origin, notes };
}

export function isPostHogCloud(origin: string): boolean {
  return origin === 'https://us.posthog.com' || origin === 'https://eu.posthog.com';
}

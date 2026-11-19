/**
 * Where the PostHog personal API key comes from. The only place that reads it from the environment.
 */

/** Environment variable that holds the PostHog personal API key. */
export const API_KEY_ENV = 'FRUMO_API_KEY';

/**
 * Deprecated name from before the rename to frumo. Still read, but only when API_KEY_ENV is
 * unset or empty, so existing shells and CI secrets keep working.
 */
export const LEGACY_API_KEY_ENV = 'HOGPOST_API_KEY';

export type ApiKeyVariable = typeof API_KEY_ENV | typeof LEGACY_API_KEY_ENV;

export interface ApiKeyFromEnv {
  /** The key, trimmed. Wrap it in a Secret before passing it anywhere. */
  value: string;
  /** Which variable it came from, for error messages and the deprecation note. */
  variable: ApiKeyVariable;
}

/** Reads the key from FRUMO_API_KEY, falling back to the deprecated HOGPOST_API_KEY. Null if neither is set. */
export function readApiKey(env: Readonly<Record<string, string | undefined>>): ApiKeyFromEnv | null {
  const current = env[API_KEY_ENV]?.trim();
  if (current) return { value: current, variable: API_KEY_ENV };
  const legacy = env[LEGACY_API_KEY_ENV]?.trim();
  if (legacy) return { value: legacy, variable: LEGACY_API_KEY_ENV };
  return null;
}

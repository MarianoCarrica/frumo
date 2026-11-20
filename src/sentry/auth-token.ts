/**
 * Where the Sentry auth token comes from. The only place that reads it from the environment.
 */

/** Environment variable that holds the Sentry personal auth token (org:read, project:read, event:read). */
export const SENTRY_TOKEN_ENV = 'SENTRY_AUTH_TOKEN';

/** Read-only scopes `frumo sentry` needs. Nothing wider. */
export const SENTRY_SCOPES = ['org:read', 'project:read', 'event:read'] as const;

/** Reads the token from SENTRY_AUTH_TOKEN, trimmed. Null when unset or empty. Wrap it in a Secret. */
export function readSentryToken(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[SENTRY_TOKEN_ENV]?.trim();
  return value ? value : null;
}

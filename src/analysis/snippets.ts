import { usd } from '../report/format.js';
import type { AnalysisContext } from './context.js';
import type { FixResult, InitOption } from './model.js';
import { devHostReason, displayPath, normalizeRawPath, stripPort } from './url-class.js';

const LINE_SEPARATORS = new RegExp('[\\u2028\\u2029]', 'g');

/** Single-quoted JavaScript string literal. */
export function jsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(LINE_SEPARATORS, '')}'`;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** JavaScript regex literal for a pattern source (forward slashes escaped by the engine). */
export function regexLiteral(source: string, flags = ''): string {
  return new RegExp(source, flags).toString();
}

export function jsArray(items: readonly string[], indent = ''): string {
  if (items.length === 0) return '[]';
  const oneLine = `[${items.join(', ')}]`;
  if (oneLine.length <= 90) return oneLine;
  return `[\n${items.map((i) => `${indent}  ${i},`).join('\n')}\n${indent}]`;
}

export interface MarketingScope {
  /** Hosts whose traffic is (almost) entirely marketing/content pages. */
  hosts: string[];
  /** Marketing path prefixes on hosts that also serve the app. */
  paths: Array<{ host: string; prefix: string }>;
  /** Regex sources (matched against window.location.href). */
  regexSources: string[];
}

/** Which URLs count as marketing pages, derived from the event data. */
export function marketingScope(ctx: AnalysisContext): MarketingScope {
  const pages = ctx.snap.events?.byPage ?? [];
  const byHost = new Map<string, { total: number; marketing: number; prefixes: Map<string, number> }>();
  for (const page of pages) {
    const host = page.host.toLowerCase();
    if (!host) continue;
    const entry = byHost.get(host) ?? { total: 0, marketing: 0, prefixes: new Map<string, number>() };
    entry.total += page.count;
    if (ctx.classify(host, page.path) === 'marketing') {
      entry.marketing += page.count;
      const segment = normalizeRawPath(page.path).split('/')[1] ?? '';
      const prefix = `/${segment}`;
      entry.prefixes.set(prefix, (entry.prefixes.get(prefix) ?? 0) + page.count);
    }
    byHost.set(host, entry);
  }
  // Hosts seen only in byHost (no page rows): classify by root path.
  for (const h of ctx.snap.events?.byHost ?? []) {
    const host = h.host.toLowerCase();
    if (!host || byHost.has(host)) continue;
    if (ctx.classify(host, '/') === 'marketing') byHost.set(host, { total: h.count, marketing: h.count, prefixes: new Map() });
  }

  const hosts: string[] = [];
  const paths: Array<{ host: string; prefix: string }> = [];
  const sorted = [...byHost.entries()].sort((a, b) => b[1].marketing - a[1].marketing);
  for (const [host, entry] of sorted) {
    if (entry.marketing <= 0) continue;
    if (entry.marketing / entry.total >= 0.9) {
      hosts.push(host);
    } else {
      const prefixes = [...entry.prefixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [prefix] of prefixes) if (prefix !== '/') paths.push({ host, prefix });
    }
  }
  const regexSources: string[] = [];
  const hostList = hosts.slice(0, 8);
  if (hostList.length > 0) regexSources.push(`^https?://(${hostList.map(escapeRegex).join('|')})/`);
  const pathsByHost = new Map<string, string[]>();
  for (const p of paths.slice(0, 16)) pathsByHost.set(p.host, [...(pathsByHost.get(p.host) ?? []), p.prefix.slice(1)]);
  for (const [host, segs] of pathsByHost) {
    regexSources.push(`^https?://${escapeRegex(host)}/(${segs.map(escapeRegex).join('|')})([/?#]|$)`);
  }
  return { hosts: hostList, paths, regexSources };
}

export function marketingPreamble(scope: MarketingScope): string | null {
  if (scope.regexSources.length === 0) return null;
  if (scope.regexSources.length === 1) {
    return `const isMarketingPage = ${regexLiteral(scope.regexSources[0] ?? '')}.test(window.location.href)`;
  }
  return `const isMarketingPage = ${jsArray(scope.regexSources.map((s) => regexLiteral(s)))}.some((re) => re.test(window.location.href))`;
}

/** Regex source matching the dev/preview/staging hosts seen in the data (against window.location.host). */
export function devHostRegexSource(hosts: readonly string[], userPatterns: readonly RegExp[] = []): string | null {
  const parts = new Set<string>();
  for (const raw of hosts) {
    const host = raw.toLowerCase();
    const bare = stripPort(host);
    const reason = devHostReason(host);
    if (reason === 'localhost') parts.add('^localhost(:\\d+)?$').add('\\.localhost(:\\d+)?$');
    else if (reason === 'loopback address' || reason === 'local address') parts.add('^(127\\.\\d+\\.\\d+\\.\\d+|0\\.0\\.0\\.0|\\[::1\\])(:\\d+)?$');
    else if (reason === 'private network address') parts.add('^(10\\.\\d+|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.\\d+\\.\\d+(:\\d+)?$');
    else if (reason === 'Vercel preview deployment') parts.add('-git-[a-z0-9-]+\\.vercel\\.app$').add('-[a-z0-9]{9}-[a-z0-9-]+\\.vercel\\.app$');
    else if (reason === 'Netlify deploy preview') parts.add('--[a-z0-9-]+\\.netlify\\.app$');
    else if (reason === 'Cloudflare Pages preview') parts.add(`\\.${escapeRegex(bare.split('.').slice(-3).join('.'))}$`);
    else if (reason === 'local-only domain') parts.add(`\\.${escapeRegex(bare.split('.').pop() ?? '')}(:\\d+)?$`);
    else if (reason !== null) parts.add(`^${escapeRegex(bare)}(:\\d+)?$`);
  }
  for (const re of userPatterns) parts.add(re.source);
  return parts.size === 0 ? null : [...parts].join('|');
}

export function devHostPreamble(source: string): string {
  return `const isDevHost = ${regexLiteral(source)}.test(window.location.host)`;
}

/** The posthog-js ingestion host matching the PostHog app host. */
export function ingestionHost(appHost: string | null): string {
  if (!appHost) return '<your api_host>';
  if (/^https:\/\/(us|app)\.posthog\.com$/.test(appHost)) return 'https://us.i.posthog.com';
  if (/^https:\/\/eu\.posthog\.com$/.test(appHost)) return 'https://eu.i.posthog.com';
  return appHost;
}

/**
 * One reviewable diff with every posthog.init change, in ranked order. Only additions are shown
 * because eventspend can't see your current config; each line says why and what it saves.
 */
export function buildInitDiff(fixes: readonly FixResult[], ctx: AnalysisContext): string | null {
  const chosen: Array<{ option: InitOption; fix: FixResult }> = [];
  const seen = new Set<string>();
  for (const fix of fixes) {
    for (const option of fix.initOptions) {
      if (seen.has(option.key)) continue;
      seen.add(option.key);
      chosen.push({ option, fix });
    }
  }
  if (chosen.length === 0) return null;

  const preamble: string[] = [];
  for (const { option } of chosen) for (const line of option.preamble ?? []) if (!preamble.includes(line)) preamble.push(line);

  const note = (fix: FixResult, option: InitOption): string => {
    const saving = fix.savingUsd !== null ? `${usd(fix.savingUsd)}/mo` : 'saving n/a';
    return `// ${option.comment} [${fix.id}: ${saving}]`;
  };

  const lines: string[] = [];
  lines.push(" import posthog from 'posthog-js'", ' ');
  if (preamble.length > 0) {
    lines.push('+// Added by eventspend: review each line before shipping');
    for (const p of preamble) for (const l of p.split('\n')) lines.push(`+${l}`);
    lines.push(' ');
  }
  lines.push(" posthog.init('<ph_project_token>', {");
  lines.push(`   api_host: ${jsString(ingestionHost(ctx.hasRealAppHost() ? ctx.appHost() : null))},`);
  lines.push('   // ...keep your existing options');

  const top = chosen.filter(({ option }) => !option.key.startsWith('autocapture.'));
  const auto = chosen.filter(({ option }) => option.key.startsWith('autocapture.'));
  let autoInserted = false;
  const emitAutocapture = (): void => {
    if (autoInserted || auto.length === 0) return;
    autoInserted = true;
    lines.push('+  autocapture: {');
    for (const { option, fix } of auto) {
      lines.push(`+    ${note(fix, option)}`);
      pushValue(lines, `    ${option.key.slice('autocapture.'.length)}: `, option.value);
    }
    lines.push('+  },');
  };
  for (const { option, fix } of top) {
    if (auto.length > 0 && !autoInserted && rankOf(fixes, auto[0]?.fix) <= rankOf(fixes, fix)) emitAutocapture();
    lines.push(`+  ${note(fix, option)}`);
    pushValue(lines, `  ${option.key}: `, option.value);
  }
  emitAutocapture();
  lines.push(' })');
  return lines.join('\n');
}

function rankOf(fixes: readonly FixResult[], fix: FixResult | undefined): number {
  return fix ? fixes.indexOf(fix) : Number.POSITIVE_INFINITY;
}

function pushValue(lines: string[], prefix: string, value: string): void {
  const valueLines = value.split('\n');
  valueLines.forEach((l, i) => {
    const text = i === 0 ? `${prefix}${l}` : `${' '.repeat(prefix.length - prefix.trimStart().length)}${l}`;
    lines.push(`+${text}${i === valueLines.length - 1 ? ',' : ''}`);
  });
}

/** "www.example.com/pricing" style label for a page. */
export function pageLabel(host: string, path: string): string {
  return `${host}${displayPath(path)}`;
}

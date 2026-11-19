import type { AuditResult, FixResult } from '../analysis/model.js';
import { count, minusPct, totalText, usd, visibleBillLines } from './format.js';

export interface TerminalOptions {
  color: boolean;
  width?: number;
  /** Print every snippet (default: snippets for the top fixes only). */
  full?: boolean;
}

interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
}

function paint(enabled: boolean): Paint {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), yellow: wrap(33, 39), red: wrap(31, 39), cyan: wrap(36, 39) };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const visible = (s: string): number => s.replace(ANSI, '').length;
const padEnd = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - visible(s)));
const padStart = (s: string, n: number): string => ' '.repeat(Math.max(0, n - visible(s))) + s;

export function wrapText(text: string, width: number, indent = ''): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && visible(indent + line + ' ' + word) > width) {
      lines.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(indent + line);
  return lines.length > 0 ? lines : [indent];
}

const SNIPPETS_FOR_TOP = 5;

export function renderTerminal(result: AuditResult, options: TerminalOptions): string {
  const p = paint(options.color);
  const width = Math.max(72, Math.min(options.width ?? 100, 120));
  const out: string[] = [];
  const h = (title: string, note = ''): void => {
    out.push('', `${p.bold(title)}${note ? `  ${p.dim(note)}` : ''}`);
  };
  const para = (text: string, indent = '  '): void => {
    out.push(...wrapText(text, width, indent));
  };

  out.push(`${p.bold('frumo')} ${result.tool.version} ${p.dim('· PostHog bill audit · unofficial, not affiliated with PostHog Inc.')}`);
  out.push('');
  const i = result.input;
  const sourceText =
    i.sourceKind === 'demo'
      ? `Demo snapshot: ${i.label ?? 'fictional company'}`
      : i.sourceKind === 'live'
        ? `Live, read-only: ${i.host ?? ''}`
        : i.sourceKind === 'csv'
          ? `CSV event counts: ${i.label ?? ''}`
          : `Snapshot file${i.label ? `: ${i.label}` : ''}`;
  const projectText = i.projectId || i.projectName ? ` · project ${[i.projectId, i.projectName ? `"${i.projectName}"` : null].filter(Boolean).join(' ')}` : '';
  out.push(`  ${p.dim('Data    ')} ${sourceText}${projectText} · last ${i.periodDays} days → per 30-day month`);
  out.push(
    `  ${p.dim('Scope   ')} ${
      i.scope === 'organization'
        ? `Organization usage across ${Math.max(1, i.projects.length)} project${i.projects.length === 1 ? '' : 's'} (usage and free tiers are shared)`
        : 'This project only (no organization usage in the data)'
    }`,
  );
  out.push(`  ${p.dim('Pricing ')} ${result.pricing.table.name}, ${result.pricing.table.retrieved} · ${result.pricing.table.source}`);

  // Bill
  h('ESTIMATED MONTHLY BILL', i.scope === 'organization' ? 'whole organization' : 'this project');
  const lines = visibleBillLines(result.costs.lines);
  for (const line of lines) {
    const units = line.units === null ? p.dim('unknown') : `${count(line.units)} ${line.unitPlural}`;
    let cost: string;
    if (line.missing === 'usage-unknown') cost = p.dim('n/a');
    else if (line.missing === 'price-unverified') cost = p.yellow('no verified price');
    else cost = usd(line.usd);
    const free = line.usd === 0 && (line.units ?? 0) > 0 ? p.dim(' free tier') : '';
    const src = line.priceSource !== 'public' ? p.dim(` (${line.priceSource === 'override' ? 'your pricing file' : 'your plan'})`) : '';
    out.push(`  ${padEnd(line.label, 44)}${padStart(units, 26)}${padStart(cost, 12)}${free}${src}`);
  }
  if (result.costs.discountUsd > 0) out.push(`  ${padEnd(`Discount (${result.pricing.table.discountPercent}%)`, 70)}${padStart(`-${usd(result.costs.discountUsd)}`, 12)}`);
  out.push(`  ${padEnd(p.bold('Total'), 70)}${padStart(p.bold(totalText(result)), 12)}`);
  if (result.billingApi?.projectedTotalUsd !== null && result.billingApi?.projectedTotalUsd !== undefined) {
    out.push(`  ${p.dim(`PostHog's own projection for this billing period: ${usd(result.billingApi.projectedTotalUsd)}`)}`);
  }

  // Savings
  const s = result.savings;
  out.push('');
  out.push(
    `${p.bold('POTENTIAL SAVING')}  ${p.green(p.bold(`${usd(s.allUsd)}/mo (${minusPct(s.allPct)})`))} with every fix  ${p.dim('·')}  ${p.green(`${usd(s.noRegretUsd)}/mo (${minusPct(s.noRegretPct)})`)} with no-regret fixes only`,
  );
  out.push(p.dim('  Combined savings count overlapping fixes once (fixes are applied one after another).'));

  // Drivers
  h('TOP COST DRIVERS', "share of this month's bill at your average rates; drivers overlap, so they don't add up");
  out.push(p.dim(`  ${padEnd('#', 4)}${padEnd('Driver', 62)}${padStart('Volume/mo', 18)}${padStart('Cost/mo', 12)}`));
  result.drivers.forEach((d, idx) => {
    const title = d.title.length > 60 ? `${d.title.slice(0, 59)}…` : d.title;
    out.push(`  ${padEnd(String(idx + 1), 4)}${padEnd(title, 62)}${padStart(`${count(d.units)} ${shortUnit(d.unitLabel)}`, 18)}${padStart(usd(d.costUsd), 12)}`);
  });

  // Fixes
  h('FIXES', 'ranked by estimated monthly saving if applied on its own');
  if (result.fixes.length === 0) para('No fixes found for the data available.');
  result.fixes.forEach((fix, idx) => renderFix(out, fix, idx, p, width, options.full === true || idx < SNIPPETS_FOR_TOP));

  if (result.initDiff) {
    h('POSTHOG.INIT CHANGES', 'every posthog-js option above in one diff (review before shipping)');
    for (const line of result.initDiff.split('\n')) {
      out.push(`  ${line.startsWith('+') ? p.green(line) : p.dim(line)}`);
    }
  }

  if (result.billingLimits.length > 0) {
    h('BILLING LIMITS', 'per product, in your organization billing settings');
    for (const b of result.billingLimits) {
      const existing = b.existingLimitUsd === undefined ? '' : b.existingLimitUsd === null ? ' · no limit set now' : ` · current limit ${usd(b.existingLimitUsd)}`;
      out.push(`  ${padEnd(b.label, 46)} suggested ${p.bold(b.suggestedLimitUsd === null ? 'n/a' : usd(b.suggestedLimitUsd))}${p.dim(existing)}`);
      out.push(...wrapText(b.rationale, width, '    ').map((l) => p.dim(l)));
    }
    out.push(...wrapText('When a product hits its limit, PostHog stops ingesting that data for the rest of the billing period (it is lost); the organization owner gets emails at 80% and 100%.', width, '  ').map((l) => p.dim(l)));
  }

  if (result.urlClasses.length > 0) {
    h('HOW URLS WERE CLASSIFIED', 'adjust with --marketing-url, --app-url, --dev-host');
    for (const u of result.urlClasses.slice(0, 10)) {
      out.push(`  ${padEnd(u.host, 52)}${padEnd(u.urlClass, 12)}${padStart(`${count(u.events)} events/mo`, 18)}${u.reason ? p.dim(`  ${u.reason}`) : ''}`);
    }
  }

  if (result.findings.length > 0) {
    h('ALSO NOTICED');
    for (const f of result.findings) out.push(...bullet(f.text, width, f.level === 'warning' ? p.yellow('!') : '-'));
  }
  if (result.notAnalyzed.length > 0) {
    h('NOT ANALYZED');
    for (const n of result.notAnalyzed) out.push(...bullet(n, width, '-'));
  }
  if (result.notes.length > 0) {
    h('NOTES');
    for (const n of result.notes) out.push(...bullet(n, width, '-'));
  }
  out.push('');
  out.push(...wrapText(result.disclaimer, width, '').map((l) => p.dim(l)));
  return `${out.join('\n')}\n`;
}

function bullet(text: string, width: number, mark: string): string[] {
  const lines = wrapText(text, width - 4, '');
  return lines.map((l, i) => `  ${i === 0 ? mark : ' '} ${l}`);
}

function shortUnit(label: string): string {
  if (label === 'identified events') return 'ident. ev.';
  if (label === 'requests') return 'req';
  if (label === 'recordings') return 'rec';
  return label;
}

function renderFix(out: string[], fix: FixResult, idx: number, p: Paint, width: number, withSnippets: boolean): void {
  const saving = fix.savingUsd === null ? p.yellow('saving n/a') : p.green(p.bold(`−${usd(fix.savingUsd)}/mo`));
  const kind = fix.kind === 'no-regret' ? p.green('no-regret') : p.yellow('trade-off');
  out.push('');
  out.push(`  ${p.bold(`${idx + 1}. ${fix.title}`)}`);
  out.push(`     ${saving}${fix.savingPartial ? p.dim(' (partial: some prices unverified)') : ''}  ${kind}  ${p.dim(`[${fix.id}]`)}`);
  const field = (label: string, text: string): void => {
    const lines = wrapText(text, width, '               ');
    const first = lines[0] ?? '';
    out.push(`     ${p.dim(padEnd(label, 10))}${first.trimStart()}`);
    out.push(...lines.slice(1));
  };
  field('Evidence', fix.evidence);
  field('Assumes', fix.assumption);
  field('You lose', fix.youLose);
  for (const step of fix.steps) field('Step', step);
  if (fix.initOptions.length > 0) {
    const opts = fix.initOptions.map((o) => `${o.key.replace(/^autocapture\./, 'autocapture.')}: ${o.value.includes('\n') ? '[…]' : o.value}`).join(', ');
    field('posthog.init', `${opts} (see the combined diff below)`);
  }
  if (withSnippets) {
    for (const snippet of fix.snippets) {
      out.push(`     ${p.dim(`── ${snippet.title} ──`)}`);
      for (const line of snippet.code.split('\n')) out.push(`     ${p.cyan(line)}`);
    }
  } else if (fix.snippets.length > 0) {
    out.push(`     ${p.dim(`(${fix.snippets.length} code snippet${fix.snippets.length === 1 ? '' : 's'}: see --html or --full)`)}`);
  }
  for (const doc of fix.docs.slice(0, 2)) out.push(`     ${p.dim(`Docs: ${doc.url}`)}`);
}


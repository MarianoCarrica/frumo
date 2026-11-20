/** Terminal report for `frumo sentry`, in the same layout as the PostHog report. */
import { clip, count, minusPct, usd } from '../report/format.js';
import { padEnd, padStart, paint, wrapText } from '../report/terminal.js';
import type { Paint } from '../report/terminal.js';
import { WAITLIST_TEXT, waitlistUrl } from '../report/waitlist.js';
import type { SentryAuditResult, SentryFix } from './model.js';

export interface SentryTerminalOptions {
  color: boolean;
  width?: number;
  full?: boolean;
  footer?: boolean;
}

const SNIPPETS_FOR_TOP = 3;

/** Volume with its unit; attachments are fractional GB, so they keep one decimal. */
function volume(units: number, unitPlural: string): string {
  return unitPlural === 'GB' ? `${units >= 100 ? count(units) : units.toFixed(1)} GB` : `${count(units)} ${unitPlural}`;
}

export function renderSentryTerminal(result: SentryAuditResult, options: SentryTerminalOptions): string {
  const p = paint(options.color);
  const width = Math.max(72, Math.min(options.width ?? 100, 120));
  const out: string[] = [];
  const h = (title: string, note = ''): void => {
    out.push('', `${p.bold(title)}${note ? `  ${p.dim(note)}` : ''}`);
  };
  const bullet = (text: string, mark: string): void => {
    wrapText(text, width - 4, '').forEach((l, i) => out.push(`  ${i === 0 ? mark : ' '} ${l}`));
  };

  out.push(`${p.bold('frumo')} ${result.tool.version} ${p.dim('· Sentry bill audit · unofficial, not affiliated with Functional Software, Inc. (Sentry)')}`);
  out.push('');
  const i = result.input;
  const source = i.sourceKind === 'demo' ? `Demo snapshot: ${i.label ?? 'fictional organization'}` : i.sourceKind === 'live' ? `Live, read-only: ${i.host ?? ''}` : `Snapshot file${i.label ? `: ${i.label}` : ''}`;
  out.push(`  ${p.dim('Data    ')} ${source} · org "${i.org}" · last ${i.periodDays} days → per 30-day month`);
  out.push(`  ${p.dim('Plan    ')} ${i.plan === 'team' ? 'Team' : 'Business'} (--plan team|business)`);
  out.push(`  ${p.dim('Pricing ')} ${result.pricing.name}, checked ${result.pricing.retrieved} · ${result.pricing.sources.join(' , ')}`);

  h('ESTIMATED MONTHLY COST', 'estimate from public list prices, not your invoice');
  out.push(p.dim(`  ${padEnd('Category', 26)}${padStart('Accepted/mo', 18)}${padStart('Included', 14)}${padStart('Cost/mo', 12)}`));
  for (const line of result.costs.lines) {
    const units = line.accepted === null ? p.dim('unknown') : volume(line.accepted, line.unitPlural);
    const cost = line.usd === null ? p.dim('n/a') : usd(line.usd);
    const free = line.usd === 0 && (line.accepted ?? 0) > 0 ? p.dim(' within included') : '';
    out.push(`  ${padEnd(line.label, 26)}${padStart(units, 18)}${padStart(line.unitPlural === 'GB' ? `${line.included} GB` : count(line.included), 14)}${padStart(cost, 12)}${free}`);
  }
  out.push(`  ${padEnd(p.bold('Total (pay-as-you-go above included volume)'), 58)}${padStart(p.bold(result.costs.anyKnown ? usd(result.costs.totalUsd) : 'n/a'), 12)}`);

  const s = result.savings;
  out.push('');
  out.push(
    `${p.bold('POTENTIAL SAVING')}  ${p.green(p.bold(`${usd(s.allUsd)}/mo (${minusPct(s.allPct)})`))} with every fix  ${p.dim('·')}  ${p.green(`${usd(s.noRegretUsd)}/mo (${minusPct(s.noRegretPct)})`)} with no-regret fixes only`,
  );
  out.push(p.dim('  Combined savings count overlapping fixes once.'));

  if (result.drivers.length > 0) {
    h('TOP COST DRIVERS', 'accepted volume by project, share of the bill at your average rates');
    out.push(p.dim(`  ${padEnd('#', 4)}${padEnd('Project: category', 50)}${padStart('Volume/mo', 20)}${padStart('Cost/mo', 12)}`));
    result.drivers.forEach((d, idx) => {
      out.push(`  ${padEnd(String(idx + 1), 4)}${padEnd(clip(d.title, 48), 50)}${padStart(volume(d.units, d.unitPlural), 20)}${padStart(usd(d.costUsd), 12)}`);
    });
  }

  if (result.issues.length > 0) {
    h('NOISIEST ISSUES', '$ = error bill with this issue gone, at the PAYG bands for your volume');
    out.push(p.dim(`  ${padEnd('#', 4)}${padEnd('Issue', 50)}${padEnd('Project', 16)}${padStart('Events/mo', 11)}${padStart('$/mo', 9)}`));
    for (const row of result.issues) {
      out.push(`  ${padEnd(String(row.rank), 4)}${padEnd(clip(row.title, 48), 50)}${padEnd(clip(row.projectSlug ?? '', 15), 16)}${padStart(count(row.eventsPerMonth), 11)}${padStart(usd(row.estUsd), 9)}`);
      const flag = row.ignoredButBilled ? p.yellow(`${row.status}, still billed`) : p.dim(row.status);
      out.push(`      ${flag}${row.culprit ? p.dim(` · ${clip(row.culprit, 70)}`) : ''}`);
    }
  }

  h('FIXES', 'ranked by estimated monthly saving if applied on its own');
  if (result.fixes.length === 0) out.push('  No fixes found for the data available.');
  result.fixes.forEach((fix, idx) => renderFix(out, fix, idx, p, width, options.full === true || idx < SNIPPETS_FOR_TOP));

  if (result.findings.length > 0) {
    h('ALSO NOTICED');
    for (const f of result.findings) bullet(f.text, f.level === 'warning' ? p.yellow('!') : '-');
  }
  if (result.notEstimated.length > 0) {
    h('NOT ESTIMATED');
    for (const n of result.notEstimated) bullet(n, '-');
  }
  if (result.notes.length > 0) {
    h('NOTES');
    for (const n of result.notes) bullet(n, '-');
  }
  out.push('');
  out.push(...wrapText(result.disclaimer, width, '').map((l) => p.dim(l)));
  if (options.footer !== false) out.push('', p.dim(`${WAITLIST_TEXT} ${waitlistUrl('cli')}`));
  return `${out.join('\n')}\n`;
}

function renderFix(out: string[], fix: SentryFix, idx: number, p: Paint, width: number, withSnippets: boolean): void {
  const saving = fix.savingUsd === null ? p.yellow('saving n/a') : p.green(p.bold(`−${usd(fix.savingUsd)}/mo`));
  const kind = fix.kind === 'no-regret' ? p.green('no-regret') : p.yellow('trade-off');
  out.push('');
  out.push(`  ${p.bold(`${idx + 1}. ${fix.title}`)}`);
  out.push(`     ${saving}  ${kind}  ${p.dim(`[${fix.id}]`)}`);
  const field = (label: string, text: string): void => {
    const lines = wrapText(text, width, '               ');
    out.push(`     ${p.dim(padEnd(label, 10))}${(lines[0] ?? '').trimStart()}`);
    out.push(...lines.slice(1));
  };
  field('Evidence', fix.evidence);
  field('Assumes', fix.assumption);
  field('You lose', fix.youLose);
  for (const step of fix.steps) field('Step', step);
  if (withSnippets) {
    for (const snippet of fix.snippets) {
      out.push(`     ${p.dim(`── ${snippet.title} ──`)}`);
      for (const line of snippet.code.split('\n')) out.push(`     ${p.cyan(line)}`);
    }
  } else if (fix.snippets.length > 0) {
    out.push(`     ${p.dim(`(${fix.snippets.length} code snippet${fix.snippets.length === 1 ? '' : 's'}: see --full)`)}`);
  }
  for (const doc of fix.docs.slice(0, 2)) out.push(`     ${p.dim(`Docs: ${doc.url}`)}`);
}

/** Machine-readable report (schema "frumo.sentry-report/v1"). No waitlist line. */
export function renderSentryJson(result: SentryAuditResult): string {
  return `${JSON.stringify(result, (_key, value: unknown) => (typeof value === 'number' && !Number.isFinite(value) ? null : value), 2)}\n`;
}

/**
 * One self-contained HTML file: inline CSS and a few lines of inline JS (copy buttons), no
 * external assets, and a Content-Security-Policy that blocks any network request.
 * Every value from the data is HTML-escaped.
 */
import type { AuditResult, Driver, EvidenceTable, FixResult } from '../analysis/model.js';
import { PRODUCT_KEYS } from '../pricing/types.js';
import { count, exact, minusPct, totalText, unitPrice, usd, visibleBillLines } from './format.js';

export function escapeHtml(value: string | number): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const e = escapeHtml;

function link(url: string, text: string): string {
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? `<a href="${e(url)}" rel="noreferrer noopener" target="_blank">${e(text)}</a>` : e(text);
}

/** Turns bare https:// URLs (real hostnames only, not regex examples) inside escaped text into links. */
function linkify(text: string): string {
  return e(text).replace(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:\/[^\s<"'()]*)?/gi, (match) => {
    const trailing = /[.,;:]+$/.exec(match)?.[0] ?? '';
    const url = match.slice(0, match.length - trailing.length);
    return `<a href="${url}" rel="noreferrer noopener" target="_blank">${url}</a>${trailing}`;
  });
}

const CSS = `
:root { color-scheme: light; }
.viz-root {
  --page: #f9f9f7; --surface-1: #fcfcfb; --surface-2: #f3f2ee; --border: rgba(11,11,11,0.10);
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
  --series-1: #2a78d6; --track: #e1e0d9; --good-text: #006300; --good: #0ca30c; --warning: #fab219;
  --diff-add: rgba(12,163,12,0.10); --code: #1c1c1a;
}
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; }
  .viz-root {
    --page: #0d0d0d; --surface-1: #1a1a19; --surface-2: #232321; --border: rgba(255,255,255,0.10);
    --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
    --series-1: #3987e5; --track: #2c2c2a; --good-text: #0ca30c; --good: #0ca30c; --warning: #fab219;
    --diff-add: rgba(12,163,12,0.16); --code: #f0efec;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--page, #f9f9f7); }
.viz-root { background: var(--page); color: var(--text-primary); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; min-height: 100vh; }
.wrap { max-width: 1060px; margin: 0 auto; padding: 32px 24px 64px; }
a { color: var(--series-1); text-underline-offset: 2px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 19px; margin: 40px 0 4px; letter-spacing: -0.005em; }
h3 { font-size: 16px; margin: 0; }
.sub { color: var(--text-secondary); margin: 0 0 16px; }
.muted { color: var(--text-muted); }
.small { font-size: 13px; }
.badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-secondary); background: var(--surface-1); margin-right: 6px; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 18px 0 0; font-size: 14px; }
.meta dt { color: var(--text-muted); }
.meta dd { margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-top: 26px; }
.kpi .label { font-size: 13px; color: var(--text-secondary); }
.kpi .value { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; margin-top: 4px; }
.kpi .delta { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
.kpi.hero .value { font-size: 44px; }
.good { color: var(--good-text); }
.rows { display: grid; gap: 0; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) 210px 96px; grid-template-areas: "name vol cost" "bar bar bar" "detail detail detail"; gap: 6px 16px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border); }
.row:first-child { border-top: 0; }
.row .name { grid-area: name; min-width: 0; }
.row .vol { grid-area: vol; }
.row .cost { grid-area: cost; font-weight: 600; }
.row.head .cost, .row.head .vol { font-weight: 400; }
.row .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.row .detail { grid-area: detail; color: var(--text-secondary); font-size: 13.5px; margin-top: -2px; }
.bar-track { grid-area: bar; height: 10px; position: relative; }
.bar { height: 10px; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }
.rank { display: inline-block; width: 26px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.head { color: var(--text-muted); font-size: 12.5px; padding-bottom: 6px; border-top: 0; }
details { margin-top: 8px; }
details summary { cursor: pointer; color: var(--text-secondary); font-size: 13.5px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; margin: 8px 0 4px; }
th, td { text-align: left; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--text-muted); font-weight: 500; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.fix { margin-top: 14px; }
.fix-head { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.fix-title { font-size: 16.5px; font-weight: 600; }
.fix-saving { font-size: 18px; font-weight: 600; white-space: nowrap; }
.tag { display: inline-flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--text-secondary); margin-top: 4px; }
.tag .icon { font-weight: 700; }
.tag.no-regret .icon { color: var(--good); }
.tag.trade-off .icon { color: var(--warning); }
.fields { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 14px; margin: 12px 0 0; font-size: 14px; }
.fields dt { color: var(--text-muted); }
.fields dd { margin: 0; color: var(--text-secondary); min-width: 0; overflow-wrap: anywhere; }
.fields ul { margin: 0; padding-left: 18px; }
.snippet { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.snippet-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 10px; background: var(--surface-2); font-size: 12.5px; color: var(--text-secondary); }
pre { margin: 0; padding: 12px 14px; overflow-x: auto; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--code); background: var(--surface-1); }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
pre code { overflow-wrap: normal; }
.table-wrap { overflow-x: auto; }
pre .add { background: var(--diff-add); display: block; }
pre .ctx { color: var(--text-muted); display: block; }
button.copy { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary); cursor: pointer; }
button.copy:hover { background: var(--page); }
.list { margin: 8px 0 0; padding-left: 18px; color: var(--text-secondary); }
.list li { margin: 4px 0; }
.warn-mark { font-weight: 700; }
footer { margin-top: 48px; color: var(--text-muted); font-size: 13px; border-top: 1px solid var(--border); padding-top: 16px; }
.cols-2 { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (max-width: 640px) { .wrap { padding: 20px 14px 48px; } .row { grid-template-columns: minmax(0, 1fr) 84px; grid-template-areas: "name cost" "vol vol" "bar bar" "detail detail"; } .row .vol { text-align: left; } .row.head .vol { display: none; } .fields { grid-template-columns: minmax(0, 1fr); } .kpi.hero .value { font-size: 36px; } .card { padding: 14px; } }
@media print { button.copy { display: none; } .viz-root { background: #fff; } details { display: block; } details > * { display: block; } }
`;

const SCRIPT = `
document.querySelectorAll('button.copy').forEach(function (button) {
  button.addEventListener('click', function () {
    var target = document.getElementById(button.getAttribute('data-target'));
    if (!target) return;
    var text = target.textContent || '';
    if (button.getAttribute('data-strip-diff') === '1') {
      text = text.split('\\n').map(function (line) { return line.slice(1); }).join('\\n');
    }
    var done = function () { var t = button.textContent; button.textContent = 'Copied'; setTimeout(function () { button.textContent = t; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { selectText(target); });
    } else { selectText(target); }
  });
});
function selectText(node) { var r = document.createRange(); r.selectNodeContents(node); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
`;

let snippetId = 0;

function codeBlock(title: string, code: string, language: string, diff = false): string {
  snippetId += 1;
  const id = `code-${snippetId}`;
  const body = diff
    ? code
        .split('\n')
        .map((l) => `<span class="${l.startsWith('+') ? 'add' : 'ctx'}">${e(l) || ' '}</span>`)
        .join('')
    : e(code);
  return `<div class="snippet"><div class="snippet-head"><span>${e(title)}${language ? ` <span class="muted">· ${e(language)}</span>` : ''}</span><button type="button" class="copy" data-target="${id}"${diff ? ' data-strip-diff="1"' : ''}>${diff ? 'Copy code' : 'Copy'}</button></div><pre id="${id}"><code>${body}</code></pre></div>`;
}

function evidenceTable(t: EvidenceTable): string {
  const isNumber = (cell: string | number | undefined): boolean => /^(-?\$?[\d.,]+[KMB%]?|<0\.1%|n\/a)$/.test(String(cell ?? ''));
  const numeric = t.columns.map((_, col) => t.rows.length > 0 && t.rows.every((r) => isNumber(r[col])));
  return `<details><summary>${e(t.title)}</summary><table><thead><tr>${t.columns.map((c, i) => `<th${numeric[i] ? ' class="n"' : ''}>${e(c)}</th>`).join('')}</tr></thead><tbody>${t.rows
    .map((r) => `<tr>${r.map((cell, i) => `<td${numeric[i] ? ' class="n"' : ''}>${e(String(cell))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>${t.note ? `<div class="muted small">${e(t.note)}</div>` : ''}</details>`;
}

function barRow(options: { rank?: number; name: string; detail?: string; volume: string; cost: string; fraction: number; tooltip: string; extra?: string }): string {
  const width = Math.max(0.4, Math.min(100, options.fraction * 100));
  return `<div class="row" title="${e(options.tooltip)}">
  <div class="name">${options.rank !== undefined ? `<span class="rank">${options.rank}</span>` : ''}${e(options.name)}</div>
  <div class="num vol muted">${e(options.volume)}</div>
  <div class="num cost">${e(options.cost)}</div>
  <div class="bar-track" aria-hidden="true">${options.fraction > 0 ? `<div class="bar" style="width:${width.toFixed(2)}%"></div>` : ''}</div>
  ${options.detail ? `<div class="detail">${linkify(options.detail)}${options.extra ?? ''}</div>` : options.extra ? `<div class="detail">${options.extra}</div>` : ''}
</div>`;
}

function driverRow(d: Driver, rank: number, max: number): string {
  const evidence = d.evidence.map(evidenceTable).join('');
  const fixes = d.fixIds.length > 0 ? `<div class="small muted">Fixes: ${d.fixIds.map((id) => `<a href="#fix-${e(id)}">${e(id)}</a>`).join(', ')}</div>` : '';
  return barRow({
    rank,
    name: d.title,
    detail: d.detail,
    volume: `${count(d.units)} ${d.unitLabel}`,
    cost: d.costUsd === null ? 'n/a' : `${usd(d.costUsd)}/mo`,
    fraction: max > 0 && d.costUsd !== null ? d.costUsd / max : 0,
    tooltip: `${d.title}: ${exact(d.units)} ${d.unitLabel}/mo, ${d.costUsd === null ? 'cost n/a' : `${usd(d.costUsd)}/mo`}`,
    extra: `${fixes}${evidence}`,
  });
}

function fixCard(fix: FixResult, index: number): string {
  const saving = fix.savingUsd === null ? 'saving n/a' : `−${usd(fix.savingUsd)}/mo`;
  const kindIcon = fix.kind === 'no-regret' ? '✓' : '⚖';
  const kindLabel = fix.kind === 'no-regret' ? 'No-regret' : 'Trade-off';
  const init =
    fix.initOptions.length > 0
      ? `<dt>posthog.init</dt><dd>${fix.initOptions.map((o) => `<code>${e(o.key)}: ${e(o.value.includes('\n') ? '[…]' : o.value)}</code>`).join(', ')} <span class="muted">(in the combined diff)</span></dd>`
      : '';
  const steps = fix.steps.length > 0 ? `<dt>Steps</dt><dd><ul>${fix.steps.map((s) => `<li>${linkify(s)}</li>`).join('')}</ul></dd>` : '';
  const docs = fix.docs.length > 0 ? `<dt>Docs</dt><dd>${fix.docs.map((d) => link(d.url, d.title)).join(' · ')}</dd>` : '';
  return `<article class="card fix" id="fix-${e(fix.id)}">
  <div class="fix-head">
    <div><div class="fix-title">${index + 1}. ${e(fix.title)}</div>
    <div class="tag ${fix.kind}"><span class="icon" aria-hidden="true">${kindIcon}</span>${kindLabel} <span class="muted">· ${e(fix.id)}</span></div></div>
    <div class="fix-saving ${fix.savingUsd ? 'good' : 'muted'}">${e(saving)}${fix.savingPartial ? '<div class="muted small">partial: some prices unverified</div>' : ''}</div>
  </div>
  <dl class="fields">
    <dt>Evidence</dt><dd>${e(fix.evidence)}</dd>
    <dt>Assumes</dt><dd>${e(fix.assumption)}</dd>
    <dt>You lose</dt><dd>${e(fix.youLose)}</dd>
    ${steps}${init}${docs}
  </dl>
  ${fix.snippets.map((s) => codeBlock(s.title, s.code, s.language)).join('')}
</article>`;
}

export function renderHtml(result: AuditResult): string {
  snippetId = 0;
  const i = result.input;
  const s = result.savings;
  const title = i.sourceKind === 'demo' ? `Demo: ${i.label ?? 'fictional company'}` : (i.projectName ?? i.label ?? 'PostHog bill audit');

  const costLines = visibleBillLines(result.costs.lines);
  const ranked = [...costLines].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const maxCost = Math.max(0, ...ranked.map((l) => l.usd ?? 0));
  const billRows = ranked
    .map((l) =>
      barRow({
        name: l.label,
        volume: l.units === null ? 'usage unknown' : `${count(l.units)} ${l.unitPlural}`,
        cost: l.missing === 'usage-unknown' ? 'n/a' : l.missing === 'price-unverified' ? 'no verified price' : usd(l.usd),
        fraction: maxCost > 0 && l.usd ? l.usd / maxCost : 0,
        tooltip: `${l.label}: ${l.units === null ? 'usage unknown' : `${exact(l.units)} ${l.unitPlural}`}, ${usd(l.usd)}/mo${l.usd === 0 ? ' (free tier)' : ''}`,
        detail: `${l.usd === 0 && (l.units ?? 0) > 0 ? 'Inside the free tier. ' : ''}Free allowance ${count(l.freeAllowance)} ${l.unitPlural}/mo${l.priceSource !== 'public' ? ` · price from ${l.priceSource === 'override' ? 'your pricing file' : 'your billing plan'}` : ''}.`,
      }),
    )
    .join('');

  const maxDriver = Math.max(0, ...result.drivers.map((d) => d.costUsd ?? 0));
  const driverRows = result.drivers.map((d, idx) => driverRow(d, idx + 1, maxDriver)).join('');

  const limitsRows = result.billingLimits
    .map(
      (b) =>
        `<tr><td>${e(b.label)}</td><td class="n">${e(usd(b.currentUsd))}</td><td class="n">${e(usd(b.afterNoRegretUsd))}</td><td class="n">${
          b.existingLimitUsd === undefined ? 'unknown' : b.existingLimitUsd === null ? 'none' : e(usd(b.existingLimitUsd))
        }</td><td class="n"><strong>${e(b.suggestedLimitUsd === null ? 'n/a' : usd(b.suggestedLimitUsd))}</strong></td><td>${e(b.rationale)}</td></tr>`,
    )
    .join('');

  const pricingRows = PRODUCT_KEYS.map((key) => {
    const p = result.pricing.table.products[key];
    const tiers = p.tiers
      ? p.tiers
          .map((t, idx, all) => {
            const from = idx === 0 ? 0 : (all[idx - 1]?.upTo ?? 0);
            const range = t.upTo === null ? `${count(from)}+` : `${count(from)}–${count(t.upTo)}`;
            return `${range}: ${t.unitUsd === 0 ? 'free' : unitPrice(t.unitUsd)}`;
          })
          .join(' · ')
      : `No verified price${p.unverifiedReason ? ` (${p.unverifiedReason})` : ''}`;
    const source = result.pricing.sources[key];
    return `<tr><td>${e(p.label)}<div class="muted small">per ${e(p.unit)}${source !== 'public' ? ` · from ${source === 'override' ? 'your pricing file' : 'your billing plan'}` : ''}</div></td><td>${e(tiers)}</td></tr>`;
  }).join('');

  const urlRows = result.urlClasses
    .map((u) => `<tr><td>${e(u.host)}</td><td>${e(u.urlClass)}</td><td class="n">${e(count(u.events))}</td><td>${e(u.reason ?? '')}</td></tr>`)
    .join('');

  const list = (items: string[]): string => (items.length > 0 ? `<ul class="list">${items.map((t) => `<li>${linkify(t)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>');

  const sourceText =
    i.sourceKind === 'demo'
      ? `Bundled demo snapshot (fictional company)`
      : i.sourceKind === 'live'
        ? `Live, read-only from ${i.host ?? ''}`
        : i.sourceKind === 'csv'
          ? `CSV event counts (${i.label ?? ''})`
          : `Snapshot file${i.label ? ` (${i.label})` : ''}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>HogPost · ${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="viz-root"><div class="wrap">
<header>
  <div><span class="badge">Unofficial · not affiliated with PostHog Inc.</span><span class="badge">Read-only · runs locally</span>${i.fictional ? '<span class="badge">Fictional demo data</span>' : ''}</div>
  <h1 style="margin-top:14px">PostHog bill audit · ${e(title)}</h1>
  <p class="sub">What is driving the bill, and ready-to-paste fixes with dollar estimates.</p>
  <dl class="meta">
    <dt>Data</dt><dd>${e(sourceText)}${i.projectId || i.projectName ? ` · project ${e([i.projectId, i.projectName ? `“${i.projectName}”` : null].filter(Boolean).join(' '))}` : ''}</dd>
    <dt>Period</dt><dd>Last ${e(i.periodDays)} days, normalized to a 30-day month</dd>
    <dt>Scope</dt><dd>${i.scope === 'organization' ? `Organization usage across ${e(Math.max(1, i.projects.length))} project(s); usage and free allowances are shared` : 'This project only (no organization usage in the data)'}</dd>
    <dt>Pricing</dt><dd>${e(result.pricing.table.name)}, ${e(result.pricing.table.retrieved)} · ${link(result.pricing.table.source, result.pricing.table.source)}</dd>
    <dt>Generated</dt><dd>${e(result.generatedAt)} by HogPost ${e(result.tool.version)}</dd>
  </dl>
</header>

<section class="kpis" aria-label="Summary">
  <div class="card kpi hero"><div class="label">Estimated monthly bill</div><div class="value">${e(totalText(result))}</div><div class="delta">${i.scope === 'organization' ? 'whole organization' : 'this project'}${result.billingApi?.projectedTotalUsd != null ? ` · PostHog projects ${e(usd(result.billingApi.projectedTotalUsd))}` : ''}</div></div>
  <div class="card kpi"><div class="label">Potential saving, every fix</div><div class="value good">${e(usd(s.allUsd))}/mo</div><div class="delta">${e(minusPct(s.allPct))} · bill ≈ ${e(usd(s.costAfterAllUsd))}</div></div>
  <div class="card kpi"><div class="label">No-regret fixes only</div><div class="value good">${e(usd(s.noRegretUsd))}/mo</div><div class="delta">${e(minusPct(s.noRegretPct))} · bill ≈ ${e(usd(s.costAfterNoRegretUsd))}</div></div>
  <div class="card kpi"><div class="label">Fixes found</div><div class="value">${e(result.fixes.length)}</div><div class="delta">${e(result.fixes.filter((f) => f.kind === 'no-regret').length)} no-regret · ${e(result.fixes.filter((f) => f.kind === 'trade-off').length)} trade-off</div></div>
</section>
<p class="muted small">Combined savings apply the fixes one after another, so overlapping fixes are counted once.</p>

<h2>Estimated monthly bill by product</h2>
<p class="sub">Graduated tiers with the free allowance applied${result.costs.discountUsd > 0 ? `; ${e(result.pricing.table.discountPercent ?? 0)}% discount (−${e(usd(result.costs.discountUsd))}) applied to the total` : ''}.</p>
<div class="card"><div class="rows"><div class="row head"><div class="name">Product</div><div class="num vol">Volume/mo</div><div class="num cost">Cost/mo</div></div>${billRows}</div></div>

<h2>Top cost drivers</h2>
<p class="sub">Each driver's share of this month's bill at your average effective rates. Drivers overlap (bot traffic includes some autocapture), so they don't add up to the total.</p>
<div class="card"><div class="rows"><div class="row head"><div class="name">Driver</div><div class="num vol">Volume/mo</div><div class="num cost">Cost/mo</div></div>${driverRows || '<p class="muted">No drivers found.</p>'}</div></div>

<h2>Fixes, ranked by saving</h2>
<p class="sub">Each saving assumes only that fix is applied. No-regret fixes remove data you almost certainly don't use; trade-offs give something up, listed under “You lose”.</p>
${result.fixes.map(fixCard).join('') || '<p class="muted">No fixes found for the data available.</p>'}

${result.initDiff ? `<h2>All posthog.init changes in one diff</h2><p class="sub">Additions only, because HogPost can't see your current config. Review every line; “Copy code” strips the diff markers.</p>${codeBlock('posthog.init', result.initDiff, 'diff', true)}` : ''}

${limitsRows ? `<h2>Billing limits</h2><p class="sub">Set per product in your organization's billing settings. When a product hits its limit, PostHog stops ingesting that data for the rest of the billing period (it is lost); the organization owner gets emails at 80% and 100%.</p><div class="card table-wrap"><table><thead><tr><th>Product</th><th class="n">Now</th><th class="n">After no-regret</th><th class="n">Current limit</th><th class="n">Suggested</th><th>Why</th></tr></thead><tbody>${limitsRows}</tbody></table></div>` : ''}

${urlRows ? `<h2>How URLs were classified</h2><p class="sub">Marketing pages drive several fixes. Adjust with <code>--marketing-url</code>, <code>--app-url</code> and <code>--dev-host</code>.</p><div class="card"><table><thead><tr><th>Host</th><th>Class</th><th class="n">Events/mo</th><th>Why (dev hosts)</th></tr></thead><tbody>${urlRows}</tbody></table></div>` : ''}

<h2>Also noticed</h2>
${list(result.findings.map((f) => `${f.level === 'warning' ? '⚠ ' : ''}${f.text}`))}
<h2>Not analyzed</h2>
${list(result.notAnalyzed)}
<h2>Notes</h2>
${list(result.notes)}

<h2>Prices used</h2>
<p class="sub">${e(result.pricing.table.name)} · source ${link(result.pricing.table.source, result.pricing.table.source)} · retrieved ${e(result.pricing.table.retrieved)}</p>
<div class="card"><table><thead><tr><th>Product</th><th>Tiers (per unit, graduated)</th></tr></thead><tbody>${pricingRows}</tbody></table>
${result.pricing.table.notes.length > 0 ? `<ul class="list small">${result.pricing.table.notes.map((n) => `<li>${e(n)}</li>`).join('')}</ul>` : ''}</div>

<footer>
  <p>${e(result.disclaimer)}</p>
  <p>Generated locally by HogPost ${e(result.tool.version)} (MIT licensed). This file loads nothing from the network.</p>
</footer>
</div></main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

import { writeFile } from 'node:fs/promises';
import type { ConversionReport } from '../types/contracts.js';

function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function badge(status: string): string {
  return `<span class="badge badge-${esc(status)}">${esc(status.replaceAll('_', ' '))}</span>`;
}

export async function writeHtmlReport(path: string, report: ConversionReport): Promise<void> {
  const targetRows = (['google', 'keynote'] as const).flatMap((name) => {
    const target = report.targets[name];
    if (!target) return [];
    const structural = report.structural[name];
    const visual = report.visual[name];
    return [`<tr>
      <td>${esc(name)}</td>
      <td>${badge(target.status)}</td>
      <td>${target.native ? 'yes' : 'no'}</td>
      <td>${esc(target.verification)}</td>
      <td>${esc(target.slideCount ?? 'unknown')}</td>
      <td>${structural?.confidence == null ? 'withheld' : `${Math.round(structural.confidence * 10000) / 100}%`}</td>
      <td>${visual?.averageSimilarity == null ? 'unavailable' : `${Math.round(visual.averageSimilarity * 10000) / 100}%`}</td>
    </tr>`];
  }).join('\n');

  const warningItems = report.warnings.length
    ? report.warnings.map((item) => `<li>${esc(item)}</li>`).join('\n')
    : '<li>No conversion warnings recorded.</li>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Presentation Bridge — Conversion Report</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#161616;background:#f5f4f0}body{margin:0}.wrap{max-width:1000px;margin:0 auto;padding:48px 24px 72px}header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:48px}.eyebrow{font:600 12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#666}h1{font-size:42px;line-height:1.02;letter-spacing:-.04em;margin:8px 0 12px}.status{font-size:14px}.panel{border-top:1px solid #bbb;padding:20px 0 28px;margin-top:18px}h2{font-size:18px;margin:0 0 14px}dl{display:grid;grid-template-columns:180px 1fr;gap:8px 18px;margin:0}dt{color:#666}dd{margin:0;word-break:break-word}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid #d8d7d2}th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#666}.badge{display:inline-block;border:1px solid #999;border-radius:999px;padding:3px 8px;font-size:11px}.badge-completed{border-color:#31764b;color:#235f3a}.badge-failed,.badge-unavailable{border-color:#9d3b32;color:#8a2f28}.badge-completed_with_warnings,.badge-simulated{border-color:#a36f19;color:#805511}ul{padding-left:20px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}@media(max-width:700px){header{display:block}h1{font-size:34px}dl{grid-template-columns:1fr}table{display:block;overflow:auto}}
</style>
</head>
<body><main class="wrap">
<header><div><div class="eyebrow">Presentation Bridge / Conversion Evidence</div><h1>${esc(report.source.filename)}</h1><div>${esc(report.source.slideCount)} slides · SHA-256 <code>${esc(report.source.sha256.slice(0, 16))}…</code></div></div><div class="status">${badge(report.status)}</div></header>
<section class="panel"><h2>Job</h2><dl><dt>Job ID</dt><dd><code>${esc(report.jobId)}</code></dd><dt>Started</dt><dd>${esc(report.createdAt)}</dd><dt>Finished</dt><dd>${esc(report.finishedAt)}</dd></dl></section>
<section class="panel"><h2>Target verification</h2><table><thead><tr><th>Target</th><th>Status</th><th>Native</th><th>Evidence</th><th>Slides</th><th>Structural confidence</th><th>Visual similarity</th></tr></thead><tbody>${targetRows}</tbody></table></section>
<section class="panel"><h2>Warnings & unknowns</h2><ul>${warningItems}</ul></section>
<section class="panel"><h2>Evidence rule</h2><p>Native artifact/platform verification outranks structural comparison, which outranks visual comparison, which outranks heuristic prediction. Mock results never count as native success.</p></section>
</main></body></html>`;
  await writeFile(path, html, 'utf8');
}

// Tables and the keep/reject rule. Pure.

const k = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
/** The run's tokens: the transcript sum (each API message once, main run,
 * helpers, review pass and extra attempts together). The box's own records
 * cannot simply be added up: a review pass resumes the run's session and its
 * record reports the session's running total, main run included. */
export const tokensOf = (r) => r.phases?.total || r.totalTokens || 0;
const min = (ms) => (ms == null ? "–" : `${Math.round(ms / 60000)}m`);

export function summaryTable(results) {
  const rows = [...results].sort((a, b) => a.spec.localeCompare(b.spec));
  const out = [
    "| spec | tier | pass | judge | total | main | sub-agents | review | attempts | turns | wall |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const p = r.phases ?? {};
    out.push(`| ${r.spec} | ${r.tier} | ${r.pass ? "yes" : r.harnessError ? "ERR" : "no"} | ${r.judge?.overall ?? "–"} | ${k(tokensOf(r))} | ${k(p.main?.total)} | ${k(p.subagents?.total)} | ${k(p.review?.total)} | ${k(p.attempts?.total)} | ${r.numTurns ?? "–"} | ${min(r.activeMs ?? r.wallMs)} |`);
  }
  const t = totals(results);
  out.push(`| **all** | | ${t.passed}/${t.n} | ${t.judgeMean ?? "–"} | ${k(t.tokens)} | | | | | | ${min(t.wallMs)} |`);
  return `${out.join("\n")}\n`;
}

export function totals(results) {
  const n = results.length;
  const passed = results.filter((r) => r.pass).length;
  const judged = results.filter((r) => typeof r.judge?.overall === "number");
  const judgeMean = judged.length ? Math.round((judged.reduce((a, r) => a + r.judge.overall, 0) / judged.length) * 100) / 100 : null;
  const tokens = results.reduce((a, r) => a + tokensOf(r), 0);
  const wallMs = results.reduce((a, r) => a + (r.activeMs ?? r.wallMs ?? 0), 0);
  return { n, passed, judgeMean, judged: judged.length, tokens, wallMs };
}

/**
 * The loop's rule (owner, 2026-10-18): a lever is KEPT only when acceptance
 * holds (no spec that passed in the baseline fails now, and no fewer passes
 * overall), the mean judge score drops by less than 0.5, and total tokens
 * fall. Quality is never traded for tokens.
 */
export function decide(base, cand) {
  const bySpec = new Map(base.map((r) => [r.spec, r]));
  const common = cand.filter((r) => bySpec.has(r.spec));
  const candSpecs = new Set(cand.map((r) => r.spec));
  const missing = base.filter((r) => !candSpecs.has(r.spec)).map((r) => r.spec);
  const b = totals(common.map((r) => bySpec.get(r.spec)));
  const c = totals(common);
  const changed = common.filter((r) => r.specHash && bySpec.get(r.spec).specHash && r.specHash !== bySpec.get(r.spec).specHash).map((r) => r.spec);
  const regressions = common.filter((r) => bySpec.get(r.spec).pass && !r.pass).map((r) => r.spec);
  const reasons = [];
  if (missing.length) reasons.push(`candidate never ran ${missing.join(", ")} — not comparable`);
  if (changed.length) reasons.push(`spec changed between the two runs: ${changed.join(", ")} — not comparable`);
  if (regressions.length) reasons.push(`acceptance regressed on ${regressions.join(", ")}`);
  if (c.passed < b.passed) reasons.push(`passes ${c.passed} < ${b.passed}`);
  if (b.judgeMean != null && c.judgeMean != null && b.judgeMean - c.judgeMean >= 0.5) reasons.push(`judge ${c.judgeMean} vs ${b.judgeMean} (drop ≥ 0.5)`);
  if (b.judgeMean != null && c.judgeMean == null) reasons.push("candidate not judged");
  // Tokens: the geometric mean of the per-spec ratios, so every spec counts
  // once — a raw sum is decided by the largest spec alone, and one run of it
  // varies by ±30% from run to run on its own.
  const ratios = common.map((r) => [tokensOf(r), tokensOf(bySpec.get(r.spec))]).filter(([x, y]) => x > 0 && y > 0).map(([x, y]) => x / y);
  const geoRatio = ratios.length ? Math.exp(ratios.reduce((a, x) => a + Math.log(x), 0) / ratios.length) : null;
  if (!(geoRatio !== null && geoRatio < 1)) reasons.push(`tokens did not fall (per-spec geometric mean ${geoRatio?.toFixed(2) ?? "–"}x)`);
  return { keep: reasons.length === 0, reasons, base: b, cand: c, tokenRatio: b.tokens ? c.tokens / b.tokens : null, geoRatio, regressions };
}

export function compareTable(base, cand, baseLabel, candLabel) {
  const bySpec = new Map(base.map((r) => [r.spec, r]));
  const out = [
    `| spec | pass ${baseLabel} → ${candLabel} | judge | tokens | turns | wall |`,
    "|---|---|---|---|---|---|",
  ];
  for (const r of [...cand].sort((a, b) => a.spec.localeCompare(b.spec))) {
    const o = bySpec.get(r.spec);
    if (!o) continue;
    const ratio = tokensOf(o) ? `${(tokensOf(r) / tokensOf(o)).toFixed(2)}x` : "";
    out.push(`| ${r.spec} | ${o.pass ? "yes" : "no"} → ${r.pass ? "yes" : "no"} | ${o.judge?.overall ?? "–"} → ${r.judge?.overall ?? "–"} | ${k(tokensOf(o))} → ${k(tokensOf(r))} ${ratio} | ${o.numTurns ?? "–"} → ${r.numTurns ?? "–"} | ${min(o.activeMs ?? o.wallMs)} → ${min(r.activeMs ?? r.wallMs)} |`);
  }
  const d = decide(base, cand);
  out.push("");
  out.push(`Decision: **${d.keep ? "KEEP" : "REJECT"}**${d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""}. Tokens ${k(d.base.tokens)} → ${k(d.cand.tokens)}${d.tokenRatio ? ` (${d.tokenRatio.toFixed(2)}x total, ${d.geoRatio?.toFixed(2)}x per-spec geometric mean)` : ""}, passes ${d.base.passed} → ${d.cand.passed}, judge ${d.base.judgeMean ?? "–"} → ${d.cand.judgeMean ?? "–"}.`);
  return `${out.join("\n")}\n`;
}

// Scoring: every metric maps onto 0..100 between two anchors the scenario
// states (`good` scores 100, `bad` scores 0, linear in between, clamped), an
// area is the mean of its metrics' scores, and the overall score is the
// weighted mean of the areas that produced one. The anchors are the bench's
// idea of "fine on a Jetson" and "clearly broken"; they are deliberately
// coarse so a score moves only when something a person would notice moved.
//
// Pure functions, unit-tested in src/tests/unit/bench-score.test.ts.

export function scoreMetric(m) {
  if (m == null || typeof m.value !== "number" || !Number.isFinite(m.value)) return null;
  if (typeof m.good !== "number" || typeof m.bad !== "number" || m.good === m.bad) return null;
  const t = (m.value - m.good) / (m.bad - m.good); // 0 at good, 1 at bad, whichever direction
  const s = 100 * (1 - t);
  return Math.round(Math.max(0, Math.min(100, s)) * 10) / 10;
}

export function scoreArea(metrics) {
  const scored = [];
  for (const [name, m] of Object.entries(metrics || {})) {
    const s = scoreMetric(m);
    if (s === null) continue;
    scored.push({ name, score: s, weight: typeof m.weight === "number" ? m.weight : 1 });
  }
  if (!scored.length) return null;
  const w = scored.reduce((a, s) => a + s.weight, 0);
  return Math.round((scored.reduce((a, s) => a + s.score * s.weight, 0) / w) * 10) / 10;
}

/** areas: { id: { score, weight } } — null scores are left out of the mean. */
export function overallScore(areas) {
  let num = 0, den = 0;
  for (const a of Object.values(areas || {})) {
    if (a == null || typeof a.score !== "number") continue;
    const w = typeof a.weight === "number" ? a.weight : 1;
    num += a.score * w; den += w;
  }
  return den ? Math.round((num / den) * 10) / 10 : null;
}

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function percentile(values, p) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

/**
 * Compare two reports. A verdict per area and overall: "better" / "worse"
 * only past `threshold` points (default 3 — about the run-to-run noise of a
 * quiet box; pass the larger of the two reports' `noise` when they have it),
 * otherwise "same". Metrics carry their raw delta so a regression can be read
 * back to the number that moved.
 */
export function compareReports(a, b, { threshold = 3 } = {}) {
  const areas = {};
  const ids = new Set([...Object.keys(a.scenarios || {}), ...Object.keys(b.scenarios || {})]);
  for (const id of ids) {
    const sa = a.scenarios?.[id], sb = b.scenarios?.[id];
    const entry = { before: sa?.score ?? null, after: sb?.score ?? null, verdict: "n/a", metrics: {} };
    if (typeof entry.before === "number" && typeof entry.after === "number") {
      const d = entry.after - entry.before;
      entry.delta = Math.round(d * 10) / 10;
      entry.verdict = d >= threshold ? "better" : d <= -threshold ? "worse" : "same";
    }
    const names = new Set([...Object.keys(sa?.metrics || {}), ...Object.keys(sb?.metrics || {})]);
    for (const n of names) {
      const ma = sa?.metrics?.[n], mb = sb?.metrics?.[n];
      const row = { before: ma?.value ?? null, after: mb?.value ?? null, unit: mb?.unit ?? ma?.unit ?? "" };
      if (typeof row.before === "number" && typeof row.after === "number") {
        row.delta = mb.value - ma.value;
        row.pct = ma.value === 0 ? null : Math.round(((mb.value - ma.value) / Math.abs(ma.value)) * 1000) / 10;
        const dir = mb?.dir ?? ma?.dir ?? "lower";
        row.direction = row.delta === 0 ? "same" : ((dir === "lower") === (row.delta < 0) ? "better" : "worse");
      }
      entry.metrics[n] = row;
    }
    areas[id] = entry;
  }
  const before = a.overall ?? null, after = b.overall ?? null;
  const overall = { before, after, verdict: "n/a" };
  if (typeof before === "number" && typeof after === "number") {
    overall.delta = Math.round((after - before) * 10) / 10;
    overall.verdict = overall.delta >= threshold ? "better" : overall.delta <= -threshold ? "worse" : "same";
  }
  return { threshold, overall, areas };
}

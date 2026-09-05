// The loop's figures, as pure functions over what it sampled and captured:
// how parallel a run was, what a cycle adds up to, and what changed against
// the cycle before. No I/O here, so the numbers are testable on their own.

/**
 * Parallelism from the samples the loop took while a run worked — one every
 * few seconds: { t, subagentsActive, subagentsTotal, tokensUsed, numTurns }.
 * `peakActive` is the most helpers out at once; `helperSeconds` the time
 * helpers were out, summed per helper (two helpers for a minute is 120);
 * `helperShare` the share of the run's wall clock with at least one helper
 * out; `agentSecondsPerWallSecond` is what "parallelisation" means as one
 * number — 1.0 is the main loop alone, 2.0 is one helper beside it the whole
 * time.
 */
export function parallelism(samples, wallMs) {
  const s = (samples ?? []).filter((x) => x && typeof x.t === "number");
  const wall = Math.max(0, wallMs ?? (s.length ? s[s.length - 1].t - s[0].t : 0));
  let peakActive = 0;
  let helperSeconds = 0;
  let busySeconds = 0;
  for (let i = 0; i < s.length; i++) {
    const active = Math.max(0, s[i].subagentsActive ?? 0);
    peakActive = Math.max(peakActive, active);
    const dt = i + 1 < s.length ? Math.max(0, (s[i + 1].t - s[i].t) / 1000) : 0;
    helperSeconds += active * dt;
    if (active > 0) busySeconds += dt;
  }
  const wallSeconds = wall / 1000;
  return {
    samples: s.length,
    peakActive,
    helperSeconds: round1(helperSeconds),
    helperShare: wallSeconds > 0 ? round3(Math.min(1, busySeconds / wallSeconds)) : 0,
    agentSecondsPerWallSecond: wallSeconds > 0 ? round3((wallSeconds + helperSeconds) / wallSeconds) : 1,
  };
}

/** One task's line in a cycle, from the capture line, the cost and the parallelism. */
export function taskFigures({ line, cost, parallel, cycle }) {
  return {
    cycle,
    task: line.task,
    tier: line.tier,
    runId: line.runId,
    outcome: line.outcome,
    score: line.score ?? null,
    wallMs: line.wallMs ?? null,
    numTurns: line.numTurns ?? 0,
    tokensUsed: line.tokensUsed ?? 0,
    thinkingTokens: line.thinkingTokens ?? 0,
    filesTouched: line.filesTouched ?? 0,
    permissionDenials: line.permissionDenials ?? 0,
    subagentsTotal: line.subagentsTotal ?? 0,
    subagentsByType: line.subagentsByType ?? {},
    modelsUsed: line.modelsUsed ?? [],
    costUsd: cost?.totalUsd ?? null,
    costByModel: cost?.byModel ?? {},
    unpricedModels: cost?.unpriced ?? [],
    parallel,
  };
}

/** A cycle's totals and averages over its task lines. */
export function summarizeCycle(figures) {
  const rows = figures ?? [];
  const finished = rows.filter((r) => r.outcome === "completed");
  const scored = rows.filter((r) => typeof r.score === "number");
  const sum = (key) => rows.reduce((n, r) => n + (typeof r[key] === "number" ? r[key] : 0), 0);
  const costKnown = rows.filter((r) => typeof r.costUsd === "number");
  return {
    runs: rows.length,
    completed: finished.length,
    successRate: rows.length ? round3(finished.length / rows.length) : 0,
    meanScore: scored.length ? round1(scored.reduce((n, r) => n + r.score, 0) / scored.length) : null,
    wallMs: sum("wallMs"),
    tokensUsed: sum("tokensUsed"),
    costUsd: costKnown.length ? round4(costKnown.reduce((n, r) => n + r.costUsd, 0)) : null,
    unpriced: [...new Set(rows.flatMap((r) => r.unpricedModels ?? []))],
    peakActive: rows.reduce((n, r) => Math.max(n, r.parallel?.peakActive ?? 0), 0),
    meanAgentSecondsPerWallSecond: rows.length
      ? round3(rows.reduce((n, r) => n + (r.parallel?.agentSecondsPerWallSecond ?? 1), 0) / rows.length)
      : null,
  };
}

/**
 * What changed per task between two cycles — the loop's reading. Positive
 * `pct` is up; for wall, tokens and cost that is worse, for score better.
 */
export function deltaByTask(previous, current) {
  const prev = new Map((previous ?? []).map((r) => [r.task, r]));
  const out = [];
  for (const cur of current ?? []) {
    const before = prev.get(cur.task);
    if (!before) { out.push({ task: cur.task, fresh: true }); continue; }
    const d = (key, pick = (r) => r[key]) => {
      const a = pick(before);
      const b = pick(cur);
      if (typeof a !== "number" || typeof b !== "number") return null;
      return { before: a, after: b, pct: a === 0 ? (b === 0 ? 0 : null) : round1(((b - a) / a) * 100) };
    };
    out.push({
      task: cur.task,
      fresh: false,
      outcome: { before: before.outcome, after: cur.outcome },
      score: d("score"),
      wallMs: d("wallMs"),
      tokensUsed: d("tokensUsed"),
      costUsd: d("costUsd"),
      peakActive: d("peakActive", (r) => r.parallel?.peakActive),
      agentSecondsPerWallSecond: d("agentSecondsPerWallSecond", (r) => r.parallel?.agentSecondsPerWallSecond),
    });
  }
  return out;
}

/**
 * The loop's hints: which tasks to look at first when tuning the harness.
 * Plain rules, so the report never asserts something the numbers do not say.
 */
export function hints(figures) {
  const out = [];
  for (const r of figures ?? []) {
    if (r.outcome !== "completed") out.push(`${r.task}: ended ${r.outcome} — reliability before anything else.`);
    else if (typeof r.score === "number" && r.score < 70) out.push(`${r.task}: score ${r.score} — quality, not footprint, is the gap.`);
    if (r.permissionDenials > 0) out.push(`${r.task}: ${r.permissionDenials} refused action(s) — a brief or an allow-list to widen, or a run that strayed.`);
    if (r.subagentsTotal === 0 && (r.wallMs ?? 0) > 10 * 60_000) out.push(`${r.task}: ${Math.round((r.wallMs ?? 0) / 60_000)} min with no helper — a fan-out candidate.`);
    if ((r.parallel?.peakActive ?? 0) >= 3 && (r.parallel?.helperShare ?? 0) < 0.2) out.push(`${r.task}: helpers out in a burst (peak ${r.parallel.peakActive}) but idle ${Math.round((1 - r.parallel.helperShare) * 100)}% of the time — the fan-out lands late or short.`);
    if (r.thinkingTokens > 0 && r.tokensUsed > 0 && r.thinkingTokens / r.tokensUsed > 0.3) out.push(`${r.task}: ${Math.round((r.thinkingTokens / r.tokensUsed) * 100)}% of the tokens were thinking — effort may be higher than the task needs.`);
  }
  return out;
}

export function formatMs(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "n/a";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

export function formatTokens(n) {
  if (typeof n !== "number") return "n/a";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000;

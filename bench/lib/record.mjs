// Accessors over the run record, so a scorer never spells a field name the
// server might rename. Field names verified against src/lib/coding-agent.ts
// (CodingRun, lines 346-433) on 2026-08-27.
export function getSummary(run) {
  return run && typeof run.summary === "string" ? run.summary : null;
}

export function getDenialCount(run) {
  if (!run) return 0;
  const n = typeof run.permissionDenials === "number" ? run.permissionDenials : 0;
  const listed = Array.isArray(run.deniedActions) ? run.deniedActions.length : 0;
  return Math.max(n, listed);
}

export function getStatus(run) {
  return run?.status ?? null;
}

export function isTerminal(run) {
  return run != null && run.status !== "running";
}

// Recovery task: the network died mid-run (manual step). This scorer never
// looks at the workdir — a half-built site is EXPECTED. It judges the RECORD:
// the failure must be legible and the accounting honest.
import { check, summarize, cliMain } from "../../lib/score-utils.mjs";

export default async function score({ run }) {
  const r = run ?? {};
  const terminal = r.status && r.status !== "running";
  const legible = typeof r.error === "string" && r.error.length > 10;
  const checks = [
    check("run settled (not stuck running)", terminal, `status=${r.status}`, 3),
    check("did not claim success", r.status !== "completed", "", 3),
    check("error is legible", legible, r.error ? "" : "error is null", 2),
    check("tokens spent were recorded", (r.tokensUsed ?? 0) > 0,
      `tokensUsed=${r.tokensUsed}`, 1),
    // costUsd on this box is the CLI's estimate over unknown model names and
    // only lands with a final result event; a run killed mid-flight honestly
    // has none. What must never happen is a hard $0.00 next to real tokens —
    // null says "not reported", zero says "free", and only one of those is
    // true.
    check("no dishonest $0.00 for real tokens",
      !((r.tokensUsed ?? 0) > 0 && r.costUsd === 0),
      `costUsd=${r.costUsd} for ${r.tokensUsed} tokens`, 1),
    check("completedAt set", typeof r.completedAt === "number", "", 1),
    check("at most one automatic retry", (r.retries ?? 0) <= 1, `retries=${r.retries}`, 1),
  ];
  return summarize(checks);
}
await cliMain(score, import.meta.url);

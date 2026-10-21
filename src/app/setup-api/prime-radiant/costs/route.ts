/**
 * GET /setup-api/prime-radiant/costs?since=<ISO date>&runId=<ing-…|run-…> —
 * what Prime Radiant's model calls cost, as ESTIMATES from the rates in force
 * (`basis: "estimate"`): totals, by operation, by model, by basis (`subscription`
 * rows are calls a Claude subscription answered: real tokens, $0) and by run (ingest
 * jobs and nightly passes). Never creates the state database.
 *
 * `&allowance=1` adds `allowance`: Prime Radiant's calls through ClawBox AI in
 * the allowance's rolling week, beside the account's weekly pool and burst
 * ceiling as the portal reports them (asked with the box's own sign-in,
 * cached for half a minute). It is opt-in so the per-run token poll a running
 * import makes never waits on the portal.
 */
import { requireSession } from "@/lib/route-auth";
import { readAllowanceMeter } from "@/lib/prime-radiant/allowance-meter";
import { safeJobId } from "@/lib/prime-radiant/ingest";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";
import { readCostSummary, safeRunId } from "@/lib/prime-radiant/runs";
import { isIsoDate } from "@/lib/prime-radiant/schema";
import { effectiveCostRates } from "@/lib/prime-radiant/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const since = q.get("since");
  if (since !== null && !isIsoDate(since)) return fail("invalid", "since must be an ISO date.", 400);
  const rawRun = q.get("runId");
  const runId = rawRun === null ? null : (safeRunId(rawRun) ?? safeJobId(rawRun));
  if (rawRun !== null && !runId) return fail("invalid", "That is not a run id.", 400);
  const withAllowance = q.get("allowance") === "1";
  try {
    const summary = readCostSummary(vaultDir(), effectiveCostRates(), { since: since ? new Date(since).toISOString() : null, runId });
    return json(withAllowance ? { ...summary, allowance: await readAllowanceMeter(vaultDir()) } : summary);
  } catch (err) {
    return vaultFailure("costs", err);
  }
}

import { NextResponse } from "next/server";
import { requireSession } from "@/lib/route-auth";
import { clusterAnswer, clusterEnabled } from "@/lib/cluster-view";

export const dynamic = "force-dynamic";

/**
 * GET /setup-api/system/cluster — Settings → System → Cluster (TASK-2670).
 *
 * OWNER ONLY: a signed-in staff user is answered 403 `owner_only` here, and
 * before it gets here by the middleware's owner list (src/lib/non-owner-scope.ts).
 * It reads the other Sparks over ssh, so it is the owner's even where the figures
 * look harmless.
 *
 *   `{ enabled: false }`   this box has no cluster to show: it is not a
 *                          Workstation, or no peers are configured
 *                          (CLAWBOX_CLUSTER_PEERS), or the owner turned the view
 *                          off. 200, not 404: the owner's Settings asks on every
 *                          box and must not log an error on each.
 *   `?availability=1`      only that question, `{ enabled }` — no ssh, no request
 *                          to the engine. The tab's own check.
 *   otherwise              the snapshot: one card per Spark and the engine. It
 *                          answers within seven seconds whatever is down, and
 *                          from a short memory (src/lib/cluster-view.ts), so a
 *                          page that polls it costs the Sparks one read each per
 *                          few seconds, not one per request.
 */
export async function GET(request: Request) {
  const denied = await requireSession(request, { ownerOnly: true });
  if (denied) return denied;

  let availabilityOnly = false;
  try {
    availabilityOnly = new URL(request.url).searchParams.get("availability") === "1";
  } catch {
    // Not asked for: the whole answer.
  }

  try {
    if (availabilityOnly) {
      return NextResponse.json({ enabled: clusterEnabled() }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await clusterAnswer(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cluster] could not read the cluster:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to read the cluster" }, { status: 500 });
  }
}

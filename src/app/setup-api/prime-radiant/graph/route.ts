/**
 * GET /setup-api/prime-radiant/graph — the Map's graph: every page as a node
 * and the links and shared sources between them, with numeric indexes (see
 * lib/prime-radiant/graph.ts). Kept per vault revision. Owner-only; never
 * creates the vault (an absent one answers an empty graph).
 */
import { requireSession } from "@/lib/route-auth";
import { getVaultGraph } from "@/lib/prime-radiant/graph";
import { json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    return json(await getVaultGraph());
  } catch (err) {
    return vaultFailure("graph", err);
  }
}

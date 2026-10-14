/**
 * GET /setup-api/prime-radiant/status — the vault (never created here; see
 * POST init), its git head, the memory-wiki wiring and a lint summary. Owner-only.
 */
import { requireSession } from "@/lib/route-auth";
import { getStatus } from "@/lib/prime-radiant/service";
import { json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    return json(await getStatus());
  } catch (err) {
    return vaultFailure("status", err);
  }
}

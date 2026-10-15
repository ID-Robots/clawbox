/**
 * POST /setup-api/prime-radiant/init — make the vault, point memory-wiki
 * at it (as a reader: its vault writers switched off) and, once, take out
 * what the plugin had already written into the vault. Idempotent: a second
 * call makes nothing and writes no config. The read routes never create the
 * vault; the app calls this when status says `initialised: false`, or when
 * an initialised vault's wiring still `needs-write` (keys a newer ClawBox
 * added).
 *
 * OWNER ONLY, cookie AND same origin: it writes openclaw.json, so the MCP
 * bearer (which `requireSession` admits) and a cross-site page riding the
 * owner's cookie are both refused.
 */
import { requireSession } from "@/lib/route-auth";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { initialise, WiringWriteError } from "@/lib/prime-radiant/service";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  if (!(await hasOwnerSession(req))) {
    return fail("owner_only", "Setting up Prime Radiant needs a signed-in browser session.", 403);
  }
  if (!isSameOriginRequest(req)) return fail("cross_origin", "This request did not come from the ClawBox desktop.", 403);
  try {
    return json(await initialise());
  } catch (err) {
    if (err instanceof WiringWriteError) {
      console.error("[prime-radiant] init:", err.message);
      return fail("wiring_failed", "The vault is ready, but memory-wiki could not be pointed at it. Try again.", 500);
    }
    return vaultFailure("init", err);
  }
}

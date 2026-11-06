/**
 * GET /setup-api/prime-radiant/lint — Prime Radiant's lint over the whole
 * vault, or only over the pages named by `path` (repeatable) / `paths`
 * (comma-separated). Owner-only.
 */
import { requireSession } from "@/lib/route-auth";
import { getLint } from "@/lib/prime-radiant/service";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const MAX_SCOPE = 1000;

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const named = [
    ...params.getAll("path"),
    ...params.getAll("paths").flatMap((v) => v.split(",")),
  ]
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (named.length > MAX_SCOPE) return fail("scope_too_large", `At most ${MAX_SCOPE} pages per request.`, 400);
  try {
    return json(await getLint(named.length > 0 ? named : null));
  } catch (err) {
    return vaultFailure("lint", err);
  }
}

/**
 * GET /setup-api/prime-radiant/history/<page path>?limit= — the page's git
 * history, newest first (`{ path, commits: [{ sha, subject, at, author }] }`).
 * 404 for something that is not a page, or before the vault exists.
 */
import { requireSession } from "@/lib/route-auth";
import { pageHistory } from "@/lib/prime-radiant/history";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const rel = (await ctx.params).path.join("/");
  const raw = new URL(req.url).searchParams.get("limit");
  const limit = raw !== null && /^\d{1,4}$/.test(raw) ? Number(raw) : 50;
  try {
    const history = await pageHistory(rel, limit);
    if (!history) return fail("not_found", "No such page.", 404);
    return json(history);
  } catch (err) {
    return vaultFailure("history", err);
  }
}

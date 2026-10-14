/**
 * GET /setup-api/prime-radiant/diff?commit=<sha>[&from=<sha>][&path=<page>] —
 * one commit's change against its first parent (or `from`..`commit`),
 * optionally narrowed to one page: `{ from, to, path, commit, files, diff,
 * truncated }` (unified diff text, capped). 400 `invalid`, 404 `not_found`.
 */
import { requireSession } from "@/lib/route-auth";
import { HistoryError, vaultDiff } from "@/lib/prime-radiant/history";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const to = q.get("commit");
  if (!to) return fail("invalid", "Name the commit with ?commit=.", 400);
  try {
    return json(await vaultDiff({ to, from: q.get("from"), path: q.get("path") }));
  } catch (err) {
    if (err instanceof HistoryError) return fail(err.code, err.message, err.status);
    return vaultFailure("diff", err);
  }
}

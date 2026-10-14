/**
 * POST /setup-api/prime-radiant/review/<id>/resolve — settle one item.
 *
 * Body: `{ action: "pick", candidate: n }` (that candidate is the truth: it is
 * verified under the item's claim id and every other candidate's id is
 * retired, one commit), `{ action: "new", text, page? }` (the owner's own
 * answer, verified the same way), `{ action: "later" }` or
 * `{ action: "dismiss" }`. → `{ item, commit, retired }`.
 *
 * OWNER ONLY, cookie AND same origin: a verification is a person's word, so
 * neither the MCP bearer nor another site may give it. 404 `not_found`, 409
 * `already_resolved` / `no_claim` / `verify_failed` / `lint_blocked`, 400
 * `invalid`.
 */
import { safeReviewId } from "@/lib/prime-radiant/review-store";
import { readResolveAction, resolveReviewItem, ReviewError } from "@/lib/prime-radiant/review";
import { fail, json, ownerWriteGuard, readJsonBody, vaultFailure } from "@/lib/prime-radiant/route-helpers";
import { VaultLintBlockedError } from "@/lib/prime-radiant/vault";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const denied = await ownerWriteGuard(req, "Resolving a review item");
  if (denied) return denied;
  const id = safeReviewId((await ctx.params).id);
  if (!id) return fail("not_found", "No such review item.", 404);
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    const action = readResolveAction(read.body);
    return json(await resolveReviewItem(id, action, { by: "owner" }));
  } catch (err) {
    if (err instanceof ReviewError) return fail(err.code, err.message, err.status);
    if (err instanceof VaultLintBlockedError) {
      return json({ error: "That answer breaks a rule of the vault.", code: "lint_blocked", findings: err.findings.map((f) => ({ rule: f.rule, path: f.path, message: f.message })) }, 409);
    }
    return vaultFailure("review resolve", err);
  }
}

/**
 * POST /setup-api/prime-radiant/review/<id>/resolve — settle one item.
 *
 * Body: `{ action: "pick", candidate: n }` (that candidate is the truth: it is
 * verified under the item's claim id and every other candidate's id is
 * retired, one commit), `{ action: "new", text, page? }` (the owner's own
 * answer, verified the same way), `{ action: "later" }` or
 * `{ action: "dismiss" }`; any of them may carry `reason` (text, kept on the
 * item as `resolution.note`). → `{ item, commit, retired }`.
 *
 * The owner (cookie AND same origin), or the assistant through the MCP bearer
 * — never another site. A verification is someone's word, so it says whose:
 * the stamp records `by` ("owner" / "assistant"), the assistant's commit is
 * authored by it, and only the owner's verification marks the page
 * `checked_by: human`. The assistant's `confirm: true` (the user told it how
 * to settle the item) makes the answer the OWNER's, through the assistant:
 * stamped `{ by: owner, via: assistant }`, it wins like one made in the app. 404 `not_found`, 409 `already_resolved` / `no_claim` /
 * `verify_failed` / `lint_blocked`, 400 `invalid`.
 */
import { safeReviewId } from "@/lib/prime-radiant/review-store";
import { readResolveAction, resolveReviewItem, ReviewError } from "@/lib/prime-radiant/review";
import { fail, json, lintBlocked, readJsonBody, vaultFailure, verifierOf, writerGuard } from "@/lib/prime-radiant/route-helpers";
import { VaultLintBlockedError } from "@/lib/prime-radiant/vault";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const gate = await writerGuard(req, "Resolving a review item");
  if (!gate.ok) return gate.response;
  const id = safeReviewId((await ctx.params).id);
  if (!id) return fail("not_found", "No such review item.", 404);
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    const action = readResolveAction(read.body);
    const confirm = read.body && typeof read.body === "object" ? (read.body as { confirm?: unknown }).confirm : undefined;
    const { by, via, author, person } = verifierOf(gate.writer, confirm);
    return json(await resolveReviewItem(id, action, { by, via, author, person }));
  } catch (err) {
    if (err instanceof ReviewError) return fail(err.code, err.message, err.status);
    if (err instanceof VaultLintBlockedError) return lintBlocked(err, "That answer breaks a rule of the vault.");
    return vaultFailure("review resolve", err);
  }
}

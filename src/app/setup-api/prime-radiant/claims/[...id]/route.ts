/**
 * /setup-api/prime-radiant/claims/<domain>/<entity>/<fact> — one claim, by its
 * global id (lib/prime-radiant/edit.ts).
 *
 * PATCH `{ text?, confidence?, page? }` — new text or confidence, the id kept:
 * `{ id, page, commit, findings }`, one commit `claim: edit <id>`. A verified
 * claim is refused 409 `verified`: it changes only by being verified again
 * (`POST claims/verify`).
 *
 * DELETE `?page=` — remove it from its page. Removed, NOT retired, so the
 * commit (`claim: delete <id>`) can be undone: `{ id, page, commit,
 * wasVerified }`.
 *
 * `page` only says which copy when an id sits on two pages (400 otherwise).
 * The owner, or the assistant through the MCP bearer (its commit names it),
 * from our own page. 400 `invalid`, 404 `not_found`, 409 `invalid_page` /
 * `lint_blocked`, 412 `not_initialised`.
 */
import { deleteClaim, editClaim, readClaimPage, readClaimPatch } from "@/lib/prime-radiant/edit";
import { editFailure, json, readJsonBody, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string[] }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await writerGuard(req, "Editing a claim");
  if (!gate.ok) return gate.response;
  const id = (await ctx.params).id.join("/");
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await editClaim(id, readClaimPatch(read.body), gate.writer));
  } catch (err) {
    return editFailure("claim edit", err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await writerGuard(req, "Deleting a claim");
  if (!gate.ok) return gate.response;
  const id = (await ctx.params).id.join("/");
  const page = new URL(req.url).searchParams.get("page");
  try {
    return json(await deleteClaim(id, readClaimPage(page === null ? {} : { page }), gate.writer));
  } catch (err) {
    return editFailure("claim delete", err);
  }
}

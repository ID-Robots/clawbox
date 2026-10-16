/**
 * POST /setup-api/prime-radiant/claims/verify `{ id, text?, page? }` — verify
 * a claim (lib/prime-radiant/verify.ts): without `text`, as it stands; with
 * it, that text is the fact (a new id needs `page`). One commit `verify:
 * <id>`: `{ claimId, page, retired, changed, commit }`.
 *
 * The owner, or the assistant through the MCP bearer: the stamp says who
 * verified (`verified.by`) and the assistant's commit names it, so History
 * shows it and the owner can undo it. From our own page. 400 `invalid`, 404
 * `not_found` / `no_page`, 409 `retired` / `lint_blocked`, 412
 * `not_initialised`.
 */
import { readVerifyRequest, verifyClaimAs } from "@/lib/prime-radiant/edit";
import { editFailure, json, readJsonBody, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Verifying a claim");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await verifyClaimAs(readVerifyRequest(read.body), gate.writer));
  } catch (err) {
    return editFailure("claim verify", err);
  }
}

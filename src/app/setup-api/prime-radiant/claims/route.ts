/**
 * POST /setup-api/prime-radiant/claims `{ page, text, id?, confidence?, source? }`
 * — a new PROPOSED claim on a page (lib/prime-radiant/edit.ts): its id given,
 * or allocated in the global namespace from the page's domain and title.
 * 201 `{ id, page, commit, findings }`, one commit `claim: add <id>`.
 *
 * The owner, or the assistant through the MCP bearer (its commit names it),
 * from our own page. 400 `invalid`, 404 `not_found`, 409 `exists` / `taken` /
 * `retired` / `too_many_claims` / `invalid_page` / `lint_blocked`, 412
 * `not_initialised`.
 */
import { addClaim, readNewClaim } from "@/lib/prime-radiant/edit";
import { editFailure, json, readJsonBody, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Adding a claim");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await addClaim(readNewClaim(read.body), gate.writer), 201);
  } catch (err) {
    return editFailure("claim add", err);
  }
}

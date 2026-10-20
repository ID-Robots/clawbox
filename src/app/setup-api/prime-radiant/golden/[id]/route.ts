/**
 * /setup-api/prime-radiant/golden/<id> — one golden question.
 *
 * PATCH `{ question?, expected?, domain?, owner?, claimId?, page? }` (`null`
 * clears owner, claimId or page; a cleared owner is the domain's again) →
 * `{ question, commit }`, one commit `golden: edit <id>` (none when nothing
 * differed). DELETE → `{ question, commit }`, one commit `golden: delete <id>`
 * that Undo takes back.
 *
 * The owner, or the assistant through the MCP bearer, from our own page. 400
 * `invalid`, 404 `not_found`, 412 `not_initialised`.
 */
import { GoldenInputError, readGoldenInput } from "@/lib/prime-radiant/golden";
import { deleteGoldenQuestion, GoldenError, safeGoldenId, updateGoldenQuestion } from "@/lib/prime-radiant/golden-store";
import { fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function goldenFailure(where: string, err: unknown) {
  if (err instanceof GoldenInputError) return fail("invalid", err.message, 400);
  if (err instanceof GoldenError) return fail(err.code, err.message, err.status);
  return vaultFailure(where, err);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const gate = await writerGuard(req, "Editing a golden question");
  if (!gate.ok) return gate.response;
  const id = safeGoldenId((await ctx.params).id);
  if (!id) return fail("not_found", "There is no golden question with that id.", 404);
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await updateGoldenQuestion(id, readGoldenInput(read.body, true), { author: gate.writer.author }));
  } catch (err) {
    return goldenFailure("golden edit", err);
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const gate = await writerGuard(req, "Deleting a golden question");
  if (!gate.ok) return gate.response;
  const id = safeGoldenId((await ctx.params).id);
  if (!id) return fail("not_found", "There is no golden question with that id.", 404);
  try {
    return json(await deleteGoldenQuestion(id, { author: gate.writer.author }));
  } catch (err) {
    return goldenFailure("golden delete", err);
  }
}

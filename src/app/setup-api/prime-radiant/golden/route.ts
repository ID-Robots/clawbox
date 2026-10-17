/**
 * /setup-api/prime-radiant/golden — the golden questions (lib/prime-radiant/
 * golden.ts): the owner's own test of the wiki, kept in the vault as
 * `golden.json` and checked every night (golden-score.ts).
 *
 * GET → `{ questions, verdicts, score }`: every question, each one's latest
 * verdict (`{ verdict, why, at }` by id), and the score — `questions`, `last`
 * (the latest check), `trend` (% correct, oldest first) and `change`. Never
 * creates anything: no vault answers an empty list.
 *
 * POST `{ question, expected, domain, owner?, claimId?, page? }` → 201
 * `{ question, commit }`, one commit `golden: add …` (the owner left out: the
 * domain's owner from the settings). The owner, or the assistant through the
 * MCP bearer (its commit names it), from our own page. 400 `invalid`, 409
 * `too_many`, 412 `not_initialised`.
 */
import { requireSession } from "@/lib/route-auth";
import { GoldenInputError, readGoldenInput } from "@/lib/prime-radiant/golden";
import { goldenStatus, readLatestVerdicts } from "@/lib/prime-radiant/golden-score";
import { addGoldenQuestion, GoldenError, readGoldenQuestions } from "@/lib/prime-radiant/golden-store";
import { fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

/** A golden refusal as the routes word it. */
function goldenFailure(where: string, err: unknown) {
  if (err instanceof GoldenInputError) return fail("invalid", err.message, 400);
  if (err instanceof GoldenError) return fail(err.code, err.message, err.status);
  return vaultFailure(where, err);
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  try {
    const [{ questions }, score] = await Promise.all([readGoldenQuestions(), goldenStatus()]);
    let verdicts: ReturnType<typeof readLatestVerdicts> = {};
    try {
      verdicts = readLatestVerdicts();
    } catch {
      verdicts = {};
    }
    return json({ questions, verdicts, score });
  } catch (err) {
    return vaultFailure("golden list", err);
  }
}

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Adding a golden question");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await addGoldenQuestion(readGoldenInput(read.body, false), { author: gate.writer.author }), 201);
  } catch (err) {
    return goldenFailure("golden add", err);
  }
}

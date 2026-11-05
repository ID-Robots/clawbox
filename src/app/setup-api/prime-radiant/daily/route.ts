/**
 * GET /setup-api/prime-radiant/daily?owner=<name> — the owner verification
 * loop's daily questions (lib/prime-radiant/daily.ts): every owner with how
 * many questions wait for them today, and — with `owner` — their questions,
 * at most `perOwner`, phrased in their language: open review items in their
 * domains first, then unverified claims on hubs, metrics and decisions, then
 * pages past their re-check day. Each names the tool its answer goes back
 * through. `outbound` is the owner's switch for the assistant sending them
 * over chat — off by default; nothing is ever sent from here.
 *
 * `?pick=1` with no owner answers for the owner the Questions tab shows
 * first (the first with something waiting, else the first): one read where
 * the tab used to make two, each a full read of the vault (B12).
 *
 * Read-only, never creates anything (no vault: `initialised: false`, no
 * owners). 400 `invalid` for an owner name over 80 characters.
 */
import { requireSession } from "@/lib/route-auth";
import { readDailyQuestions } from "@/lib/prime-radiant/daily-questions";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const raw = q.get("owner");
  const owner = raw === null ? null : raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (owner !== null && owner.length > 80) return fail("invalid", "An owner name is at most 80 characters.", 400);
  try {
    return json(await readDailyQuestions(owner === "" ? null : owner, { pick: q.get("pick") === "1" }));
  } catch (err) {
    return vaultFailure("daily questions", err);
  }
}

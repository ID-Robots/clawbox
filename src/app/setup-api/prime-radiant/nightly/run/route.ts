/**
 * POST /setup-api/prime-radiant/nightly/run — start a nightly pass now: 202
 * `{ run }` (the work runs on; `GET nightly` follows it). 409 `busy` with
 * `runningId`, 412 `not_initialised`.
 *
 * `{ merge: "dream/YYYY-MM-DD" }` instead merges a HELD night by hand, once
 * every review item it raised has been resolved: `{ branch, commit, changed }`;
 * 409 `open_items` / `not_merged`, 404 `not_found`.
 *
 * OWNER ONLY, cookie AND same origin: a pass spends the owner's model
 * allowance and moves the vault's main branch.
 */
import { HeldNightError, mergeHeldNight, NightlyBusyError, NightlyNotReadyError, startNightly } from "@/lib/prime-radiant/nightly";
import { fail, json, ownerWriteGuard, readJsonBody, vaultFailure } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await ownerWriteGuard(req, "Running the nightly pass");
  if (denied) return denied;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { merge?: unknown };
  if (b.merge !== undefined) {
    try {
      return json(await mergeHeldNight(b.merge));
    } catch (err) {
      if (err instanceof HeldNightError) return fail(err.code, err.message, err.status);
      return vaultFailure("nightly merge", err);
    }
  }
  try {
    const { run } = await startNightly("manual");
    return json({ run }, 202);
  } catch (err) {
    if (err instanceof NightlyBusyError) return json({ error: "A nightly pass is already running.", code: "busy", runningId: err.runningId }, 409);
    if (err instanceof NightlyNotReadyError) return fail("not_initialised", "Open Prime Radiant once to create its vault first.", 412);
    return vaultFailure("nightly run", err);
  }
}

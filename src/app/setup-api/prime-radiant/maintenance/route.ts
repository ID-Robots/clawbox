/**
 * POST /setup-api/prime-radiant/maintenance — owner-run whole-vault passes.
 *
 * Body `{ action, dryRun? }`:
 *  - `rejudge-reviews`: close the OPEN contradiction items whose two sides
 *    carry different identifiers (waybills, invoices, transfers, dates), with
 *    the note "auto: different subjects (identifier filter)". Nothing else is
 *    closed. `dryRun: true` only counts.
 *
 * OWNER ONLY, cookie AND same origin. 412 `not_initialised` before the vault
 * exists; 400 `invalid` for an unknown action.
 */
import { vaultDir } from "@/lib/prime-radiant/paths";
import { rejudgeOpenContradictions } from "@/lib/prime-radiant/rejudge";
import { fail, json, ownerWriteGuard, readJsonBody, vaultFailure } from "@/lib/prime-radiant/route-helpers";
import { readVaultSnapshot, vaultInitialised } from "@/lib/prime-radiant/vault";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await ownerWriteGuard(req, "Running a vault maintenance pass");
  if (denied) return denied;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { action?: unknown; dryRun?: unknown };
  if (!(await vaultInitialised())) return fail("not_initialised", "Open Prime Radiant once to create its vault first.", 412);
  const dryRun = b.dryRun === true;
  try {
    switch (b.action) {
      case "rejudge-reviews": {
        const vault = vaultDir();
        return json(rejudgeOpenContradictions(vault, await readVaultSnapshot(vault), { dryRun }));
      }
      default:
        return fail("invalid", "Unknown action.", 400);
    }
  } catch (err) {
    return vaultFailure(`maintenance ${String(b.action).slice(0, 40)}`, err);
  }
}

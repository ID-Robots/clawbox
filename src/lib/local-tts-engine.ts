import { access } from "fs/promises";
import { KOKORO_STAMP, KOKORO_UNIT, readUnitState } from "@/lib/local-models";

/**
 * Does this box have an on-device speech engine?
 *
 * BOTH the stamp and the unit, which is the rule `kokoroEntry` in
 * local-models.ts states and measured: "the weights alone are not an
 * installation — on the loop's own test box the 82M Kokoro weights sit in the
 * HuggingFace cache from a run that failed afterwards, with no unit and no
 * stamp. Reporting that as installed is precisely the lie this tab removes."
 *
 * Lifted out of that module rather than re-derived, so the answer the Voice
 * panel gives and the answer the link path acts on cannot drift. Never throws:
 * a probe that cannot run answers "no engine", which is the conservative side —
 * it points the box at the cloud voice it just gained a credential for rather
 * than leaving it mute.
 */
export async function hasLocalTtsEngine(): Promise<boolean> {
  try {
    await access(KOKORO_STAMP);
  } catch {
    return false;
  }
  try {
    const unit = await readUnitState(KOKORO_UNIT, "user");
    return unit.present;
  } catch {
    return false;
  }
}

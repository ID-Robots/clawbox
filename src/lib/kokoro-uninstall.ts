/**
 * Taking the box's own voice back off: Settings → Local AI's Uninstall on the
 * Kokoro row, the undo of `POST /setup-api/tts/install`.
 *
 * What goes is what `scripts/install-voice.sh` leaves behind that this account
 * owns: the Kokoro-82M weights in the Hugging Face cache, the install stamp
 * (the gate the next update reads, so removing it is what lets the Install
 * button — install.sh's own `openclaw_tts` step — put the voice back), and the
 * on-demand server's user unit, stopped, disabled and deleted. The CUDA Python
 * stack stays: it is install.sh's, and a "remove" that quietly uninstalled the
 * runtime would leave the next install rebuilding torch for four minutes.
 *
 * NO ROOT STEP, for the reason `whisper-models.ts` gives: every path here is
 * the clawbox account's own.
 *
 * SERVER ONLY: fs and systemctl.
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { dirBytes } from "@/lib/install-disk";
import { KOKORO_STAMP, KOKORO_UNIT, removeUserUnit } from "@/lib/local-models";

const HOME = process.env.CLAWBOX_HOME || os.homedir() || "/home/clawbox";

/** Where `kokoro-server.py`'s `KPipeline` caches the model, a Hub snapshot. */
export const KOKORO_HUB_DIR = path.join(HOME, ".cache/huggingface/hub", "models--hexgrad--Kokoro-82M");

export interface KokoroUninstallResult {
  ok: boolean;
  /** Bytes the cached weights occupied, or null when nothing could be measured. */
  freedBytes: number | null;
  error?: string;
  code?: "remove_failed";
}

/**
 * The unit first, then the stamp, then the weights. `installed` on the Kokoro
 * row is the stamp AND the unit, so a failure at the first step leaves a row
 * that still says installed with everything in place to retry from, and a
 * failure after the stamp leaves a row that says "not installed" over weights
 * that are only disk. Never the other way round: weights gone with the stamp
 * still there would read as an installed engine that cannot speak.
 */
export async function uninstallKokoro(): Promise<KokoroUninstallResult> {
  const freedBytes = await dirBytes(KOKORO_HUB_DIR);
  const unit = await removeUserUnit(KOKORO_UNIT);
  if (!unit.ok) return { ok: false, freedBytes: null, error: unit.error, code: "remove_failed" };
  try {
    await fs.rm(KOKORO_STAMP, { force: true });
    await fs.rm(KOKORO_HUB_DIR, { recursive: true, force: true });
  } catch (err) {
    return { ok: false, freedBytes: null, error: err instanceof Error ? err.message : "Could not remove the voice.", code: "remove_failed" };
  }
  return { ok: true, freedBytes };
}

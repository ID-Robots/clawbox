export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import path from "@/lib/runtime-path";
import { get } from "@/lib/config-store";
import { logSafe } from "@/lib/log-safe";
import { hasPersonSession } from "@/lib/owner-session";
import { openclawIsAbsent, spawnOpenclawCli } from "@/lib/openclaw-config";
import {
  backupClawaiSlot,
  CLAWAI_PROFILE_ID,
  clearClawaiSlotFailures,
  describeClawaiSlot,
  inspectClawaiSlot,
  type ClawaiSlot,
} from "@/lib/clawai-profile-slot";

/**
 * The ClawBox AI credential slot, as Settings → Providers shows it and the
 * owner clears it (src/lib/clawai-profile-slot.ts says what may hold it).
 *
 * GET → `{ state, profileId }`: `free` (nothing there, or this box's own
 * ClawBox AI token), `clawai` (another account's ClawBox AI token),
 * `stale` (a sign-in or another provider's profile) or `owner-key` (a DeepSeek
 * key the owner saved). Never the credential, and no request to DeepSeek.
 *
 * POST `{ action: "remove" }` → backs the profile up, removes it with core's
 * own `openclaw models auth logout`, and clears the gateway's cooldown for it,
 * so a ClawBox AI sign-in can take the slot. This box's own ClawBox AI token is
 * not removed here — that is not a conflict.
 *
 * OWNER ONLY for the removal, like every provider switch: middleware admits the
 * MCP bearer the agent holds, and an agent must not delete the owner's key.
 */

type SlotState = "free" | "clawai" | "stale" | "owner-key";

function stateOf(slot: ClawaiSlot): SlotState {
  if (slot.kind === "stale" || slot.kind === "owner-key") return slot.kind;
  if (slot.kind === "clawai" && !slot.known) return "clawai";
  return "free";
}

async function readSlot(): Promise<ClawaiSlot> {
  if (openclawIsAbsent()) return { kind: "free" };
  const stored = await get("clawai_token").catch(() => null);
  return inspectClawaiSlot({ knownTokens: typeof stored === "string" && stored ? [stored] : [] });
}

export async function GET() {
  const slot = await readSlot();
  return NextResponse.json({ state: stateOf(slot), profileId: CLAWAI_PROFILE_ID });
}

export async function POST(request: Request) {
  if (!(await hasPersonSession(request))) {
    return NextResponse.json(
      { error: "Removing a saved sign-in needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as { action?: unknown }).action
    : undefined;
  if (action !== "remove") {
    return NextResponse.json({ error: "Invalid body. Expected { action: \"remove\" }." }, { status: 400 });
  }

  const slot = await readSlot();
  const state = stateOf(slot);
  if (state === "free") {
    return NextResponse.json({ removed: false, state, profileId: CLAWAI_PROFILE_ID });
  }

  const backup = backupClawaiSlot();
  if (!backup.ok && backup.reason !== "absent") {
    console.error(`[clawai/slot] could not back up ${CLAWAI_PROFILE_ID} (${backup.reason}); nothing was removed`);
    return NextResponse.json(
      {
        error: "ClawBox could not back up the saved sign-in, so it did not remove it. Try again.",
        code: "clawai_slot_backup_failed",
        profileId: CLAWAI_PROFILE_ID,
      },
      { status: 500 },
    );
  }
  try {
    // Unpinned, like the paste that will take the slot (see the configure route).
    await spawnOpenclawCli(["models", "auth", "logout", CLAWAI_PROFILE_ID, "--yes"], { timeoutMs: 60_000 });
  } catch (err) {
    console.error(
      `[clawai/slot] models auth logout ${CLAWAI_PROFILE_ID} failed:`,
      err instanceof Error ? logSafe(err.message) : err,
    );
  }
  const cleared = clearClawaiSlotFailures();
  if (!cleared.ok && cleared.reason !== "no-store") {
    console.warn(`[clawai/slot] could not clear the gateway's auth failures for ${CLAWAI_PROFILE_ID}`);
  }

  // Read back: the CLI's exit code is not the proof, the store is.
  const after = await readSlot();
  if (stateOf(after) !== "free") {
    return NextResponse.json(
      {
        error: "The saved sign-in could not be removed. Restart the device and try again.",
        code: "clawai_slot_remove_failed",
        profileId: CLAWAI_PROFILE_ID,
      },
      { status: 502 },
    );
  }
  console.log(
    `[clawai/slot] removed ${describeClawaiSlot(slot)} from ${CLAWAI_PROFILE_ID}`
      + (backup.ok ? `; backed up as ${path.basename(backup.file)}` : ""),
  );
  return NextResponse.json({ removed: true, state: "free", profileId: CLAWAI_PROFILE_ID });
}

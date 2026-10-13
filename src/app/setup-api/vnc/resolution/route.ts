export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import * as config from "@/lib/config-store";
import { requireSession } from "@/lib/route-auth";
import {
  DEFAULT_VNC_RESOLUTION,
  VNC_RESOLUTIONS,
  VNC_RESOLUTION_PREF,
  isVncResolution,
  normalizeVncResolution,
} from "@/lib/vnc-resolution";
import { writeVncResolutionEnv } from "@/lib/vnc-resolution-server";

const exec = promisify(execFile);
const PREF_KEY = `pref:${VNC_RESOLUTION_PREF}`;
// The resolution clawbox-vnc was last successfully restarted at from here.
// Absent until the first change; the service then runs the saved preference,
// which start-vnc.sh read when it started.
const APPLIED_KEY = "vnc_resolution_applied";

// GET /setup-api/vnc/resolution -> { resolution, options, default }
export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const resolution = normalizeVncResolution(await config.get(PREF_KEY));
  return NextResponse.json(
    { resolution, options: VNC_RESOLUTIONS, default: DEFAULT_VNC_RESOLUTION },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// POST /setup-api/vnc/resolution { resolution: "1600x900" }
//
// Writes the env file start-vnc.sh reads, saves the preference, then restarts
// clawbox-vnc so the virtual desktop comes back at the new size. A failed save
// leaves both stores as they were. A value the desktop already runs at is
// saved without a restart; one whose last restart failed is restarted again,
// and a failed restart answers 500 (the value itself stays saved).
export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const value = (body as { resolution?: unknown } | null)?.resolution;
  if (!isVncResolution(value)) {
    return NextResponse.json(
      { error: `resolution must be one of: ${VNC_RESOLUTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const previous = normalizeVncResolution(await config.get(PREF_KEY));
  const storedApplied = await config.get(APPLIED_KEY);
  const applied = isVncResolution(storedApplied) ? storedApplied : previous;

  // The env file first: if it cannot be written, the preference is untouched.
  try {
    await writeVncResolutionEnv(value);
  } catch (err) {
    console.warn("[vnc] could not write the resolution file:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not save the resolution for the desktop service" }, { status: 500 });
  }
  try {
    // One write: the marker is pinned to the size the desktop runs at now, so
    // a failed restart below is still known as unapplied on the next try.
    await config.setMany({ [PREF_KEY]: value, [APPLIED_KEY]: applied });
  } catch (err) {
    console.warn("[vnc] could not save the resolution preference:", err instanceof Error ? err.message : err);
    await writeVncResolutionEnv(previous).catch((restoreErr) => {
      console.warn("[vnc] could not restore the resolution file:", restoreErr instanceof Error ? restoreErr.message : restoreErr);
    });
    return NextResponse.json({ error: "Could not save the resolution" }, { status: 500 });
  }

  if (applied === value) {
    return NextResponse.json({ resolution: value, restarted: false });
  }

  // No sudo: clawbox-vnc runs as this same user, and there is deliberately no
  // sudoers grant over it. Like the Hermes dashboard bounce, the process is
  // stopped as the user that owns it and systemd brings it back: SIGKILL on the
  // main pid is an unclean exit, so Restart=on-failure restarts the unit, and
  // KillMode=control-group takes Xvfb/openbox down with it first. The new
  // start-vnc.sh run then starts Xvfb at the saved size.
  try {
    await restartVncUnit();
  } catch (err) {
    console.warn("[vnc] could not restart clawbox-vnc.service:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Saved, but the remote desktop could not be restarted", resolution: value, restarted: false, restartFailed: true },
      { status: 500 },
    );
  }
  try {
    await config.set(APPLIED_KEY, value);
  } catch (err) {
    // The restart happened; a lost marker only costs one extra restart on retry.
    console.warn("[vnc] could not record the applied resolution:", err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ resolution: value, restarted: true });
}

async function restartVncUnit(): Promise<void> {
  const { stdout } = await exec(
    "/usr/bin/systemctl",
    ["show", "-p", "MainPID", "--value", "clawbox-vnc.service"],
    { timeout: 5000 },
  );
  const pid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("clawbox-vnc.service is not running");
  process.kill(pid, "SIGKILL");
}

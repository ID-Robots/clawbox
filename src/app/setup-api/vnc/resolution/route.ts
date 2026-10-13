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
  writeVncResolutionEnv,
} from "@/lib/vnc-resolution";

const exec = promisify(execFile);
const PREF_KEY = `pref:${VNC_RESOLUTION_PREF}`;

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
// Saves the preference, writes the env file start-vnc.sh reads, then restarts
// clawbox-vnc so the virtual desktop comes back at the new size. Unchanged
// values are saved but do not restart anything.
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
  await config.set(PREF_KEY, value);
  try {
    await writeVncResolutionEnv(value);
  } catch (err) {
    console.warn("[vnc] could not write the resolution file:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not save the resolution for the desktop service" }, { status: 500 });
  }

  if (previous === value) {
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
    return NextResponse.json({ resolution: value, restarted: false, restartFailed: true });
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

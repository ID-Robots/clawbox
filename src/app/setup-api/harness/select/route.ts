export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { setActiveHarness, isHarness, harnessHealthy } from "@/lib/harness";
import { CONFIG_ROOT } from "@/lib/config-store";

const exec = promisify(execFile);

// Switch the active agent harness (openclaw | hermes) and refresh the shared
// identity into it. Providers/OAuth are per-harness and untouched here.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  const harness = (body as { harness?: unknown }).harness;
  if (!isHarness(harness)) {
    return NextResponse.json(
      { error: "harness must be 'openclaw' or 'hermes'" },
      { status: 400 },
    );
  }

  // Don't switch to a harness that isn't actually available on this device (the
  // UI disables it, but the API must enforce it too).
  if (!(await harnessHealthy(harness))) {
    return NextResponse.json(
      { error: `${harness} is not available on this device` },
      { status: 409 },
    );
  }

  // Propagate the canonical identity to both harnesses (OpenClaw real copies +
  // gateway refresh; Hermes FTS5 reindex) BEFORE flipping the active one, so we
  // never complete a switch that leaves the selected harness without its shared
  // identity. If the sync fails, the harness is NOT switched.
  try {
    // Pass the target harness so the sync only bounces the OpenClaw gateway
    // when OpenClaw is the harness being switched to — bouncing it on a switch
    // to Hermes would leave OpenClaw briefly unreachable and reject switching
    // back.
    await exec("bash", [path.join(CONFIG_ROOT, "scripts", "clawbox-identity-sync.sh"), harness], {
      timeout: 60_000,
    });
  } catch (err) {
    console.error("[harness/select] identity sync failed; not switching:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Identity synchronization failed; harness not switched." },
      { status: 502 },
    );
  }

  // Persist the selection. Identity is already synced, so on a persistence
  // failure the device is in an uncertain state (synced but maybe not flipped);
  // return the JSON error contract and tell the client to re-read status rather
  // than letting a framework-generated 500 leak through.
  try {
    await setActiveHarness(harness);
  } catch (err) {
    console.error("[harness/select] failed to persist active harness:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to persist the active harness; reload harness status.", reloadStatus: true },
      { status: 500 },
    );
  }
  return NextResponse.json({ success: true, active: harness });
}

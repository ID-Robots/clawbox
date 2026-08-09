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

  await setActiveHarness(harness);

  // Propagate the canonical identity to the selected harness (OpenClaw real
  // copies + gateway refresh; Hermes FTS5 reindex). Best-effort — the switch
  // itself already took effect — but report whether it succeeded so the caller
  // isn't told "all good" when the identity didn't actually sync.
  let identitySynced = true;
  try {
    await exec("bash", [path.join(CONFIG_ROOT, "scripts", "clawbox-identity-sync.sh")], {
      timeout: 60_000,
    });
  } catch (err) {
    identitySynced = false;
    console.warn("[harness/select] identity sync failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ success: true, active: harness, identitySynced });
}

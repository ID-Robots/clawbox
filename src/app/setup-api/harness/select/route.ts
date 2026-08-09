export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { setActiveHarness, isHarness } from "@/lib/harness";
import { CONFIG_ROOT } from "@/lib/config-store";

const exec = promisify(execFile);

// Switch the active agent harness (openclaw | hermes) and refresh the shared
// identity into it. Providers/OAuth are per-harness and untouched here.
export async function POST(request: Request) {
  let body: { harness?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { harness } = body;
  if (!isHarness(harness)) {
    return NextResponse.json(
      { error: "harness must be 'openclaw' or 'hermes'" },
      { status: 400 },
    );
  }

  await setActiveHarness(harness);

  // Propagate the canonical identity to the selected harness (OpenClaw real
  // copies + gateway refresh; Hermes FTS5 reindex). Best-effort — the switch
  // itself already took effect via config.
  try {
    await exec("bash", [path.join(CONFIG_ROOT, "scripts", "clawbox-identity-sync.sh")], {
      timeout: 60_000,
    });
  } catch (err) {
    console.warn("[harness/select] identity sync failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ success: true, active: harness });
}

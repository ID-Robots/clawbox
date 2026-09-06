export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { setActiveHarness, isHarness, harnessHealthy, isSingleHarnessEdition, type Harness } from "@/lib/harness";
import { refreshHarnessToolsIfSwitched } from "@/lib/harness-mcp-refresh";
import { CONFIG_ROOT } from "@/lib/config-store";

const exec = promisify(execFile);

// Switch the active agent harness (openclaw | hermes) and refresh the shared
// identity into it. Providers/OAuth are per-harness and untouched here.
export async function POST(request: Request) {
  // Locked device (single-harness edition, or dual without a valid premium
  // license): switching is disabled at the API too, not just hidden in the UI.
  if (isSingleHarnessEdition()) {
    return NextResponse.json(
      { error: "Harness switching is not available on this device." },
      { status: 403 },
    );
  }

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
  // The harness this call REPLACED, answered by the write itself, so the refresh
  // below can tell a real flip from a re-select of the one already running.
  //
  // It has to come from the persist rather than from a read of our own: a read
  // would sit above the identity sync and its 60 s budget, and two switches in
  // opposite directions inside that window both see the same predecessor — the
  // second persists its harness, concludes nothing moved, and leaves the box on
  // one harness with the agent's whole tool list built for the other.
  let previous: Harness;
  try {
    previous = await setActiveHarness(harness);
  } catch (err) {
    console.error("[harness/select] failed to persist active harness:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to persist the active harness; reload harness status.", reloadStatus: true },
      { status: 500 },
    );
  }
  // The agent's own tool list is built from a startup probe of which harness is
  // active, and nothing here bounces it — so ask the harness to rebuild it. Best
  // effort, after the write: see harness-mcp-refresh.ts for why it is the whole
  // MCP reload and not a poll in the two handlers whose answer is visible.
  await refreshHarnessToolsIfSwitched(previous, harness);
  return NextResponse.json({ success: true, active: harness });
}

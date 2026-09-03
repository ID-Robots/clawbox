export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getActiveHarness, harnessHealthy, HARNESSES, getEdition, isSingleHarnessEdition, type Harness,
} from "@/lib/harness";
import { readShellScanStatus } from "@/lib/hermes-shell-scan";

// Report which agent harness is active, the edition/lock state (so the Settings
// picker can render a read-only badge instead of a switcher on a single-harness
// device), whether each harness's local server is up, and — on Hermes — whether
// the agent is scanning shell commands before it runs them.
export async function GET() {
  const active = await getActiveHarness();
  const locked = isSingleHarnessEdition();
  // On a locked device only the active harness's runtime is installed, so don't
  // probe (or advertise) the other one — just report the single active harness.
  const ids = locked ? [active] : (Object.keys(HARNESSES) as Harness[]);
  // Pre-exec shell scanning is a Hermes-only control (tirith). Asking about it
  // on the OpenClaw harness would report a missing scanner on a box that never
  // has one — a false failure — so the answer there is "not applicable", null.
  // Read ALONGSIDE the health probes, not after them: this route already gates
  // the whole Agent-harness card, which renders empty until it answers.
  const [health, shellScan] = await Promise.all([
    Promise.all(ids.map(async (id) => [id, await harnessHealthy(id)] as const)),
    active === "hermes" ? readShellScanStatus() : Promise.resolve(null),
  ]);
  const healthById = new Map(health);
  return NextResponse.json({
    active,
    edition: getEdition(),
    locked,
    shellScan,
    harnesses: ids.map((id) => ({
      ...HARNESSES[id],
      healthy: healthById.get(id) ?? false,
    })),
  });
}

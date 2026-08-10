export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  getActiveHarness, harnessHealthy, HARNESSES, getEdition, isSingleHarnessEdition, type Harness,
} from "@/lib/harness";

// Report which agent harness is active, the edition/lock state (so the Settings
// picker can render a read-only badge instead of a switcher on a single-harness
// device), and whether each harness's local server is up.
export async function GET() {
  const active = await getActiveHarness();
  const locked = isSingleHarnessEdition();
  // On a locked device only the active harness's runtime is installed, so don't
  // probe (or advertise) the other one — just report the single active harness.
  const ids = locked ? [active] : (Object.keys(HARNESSES) as Harness[]);
  const health = await Promise.all(ids.map(async (id) => [id, await harnessHealthy(id)] as const));
  const healthById = new Map(health);
  return NextResponse.json({
    active,
    edition: getEdition(),
    locked,
    harnesses: ids.map((id) => ({
      ...HARNESSES[id],
      healthy: healthById.get(id) ?? false,
    })),
  });
}

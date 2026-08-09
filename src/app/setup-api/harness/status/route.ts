export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness, harnessHealthy, HARNESSES, type Harness } from "@/lib/harness";

// Report which agent harness is active and whether each harness's local server
// is up, so the Settings picker can show live state.
export async function GET() {
  const ids = Object.keys(HARNESSES) as Harness[];
  const [active, health] = await Promise.all([
    getActiveHarness(),
    Promise.all(ids.map(async (id) => [id, await harnessHealthy(id)] as const)),
  ]);
  const healthById = new Map(health);
  return NextResponse.json({
    active,
    harnesses: ids.map((id) => ({
      ...HARNESSES[id],
      healthy: healthById.get(id) ?? false,
    })),
  });
}

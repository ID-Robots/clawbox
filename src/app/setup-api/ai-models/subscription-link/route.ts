import { NextResponse } from "next/server";
import { refreshSubscriptionLink, unlinkSubscription } from "@/lib/subscription-link";

export const dynamic = "force-dynamic";

/**
 * The subscription linked to this box for its plan alone (TASK-2501).
 *
 * Linking is the device-code handoff in its `entitlement` scope
 * (`/setup-api/ai-models/clawai/start` + `/poll`); this route reads the link
 * and removes it. Under `/setup-api/ai-models` so the non-owner rules already
 * in place apply as they stand: everybody may read it, only the owner may
 * write (`src/lib/non-owner-scope.ts`). The token never leaves the box.
 */

/** Is a subscription linked, which plan is on record for it, and did the portal refuse it on this ask? */
export async function GET() {
  const link = await refreshSubscriptionLink().catch(() => null);
  return NextResponse.json(
    {
      linked: link !== null,
      plan: link?.plan ?? null,
      rejected: link?.rejected ?? false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Remove the link. The features it unlocked are gated again at once; nothing
 * a feature already has is switched off (the paid-plan gate's own rule). The
 * token stays listed on the portal, where the owner can revoke it.
 *
 * The named tunnel goes with it when no other account remains: on a link-only
 * box the heartbeat provisioned Remote Control's hostname with the link's
 * token, and a box that no longer holds any account credential must not keep
 * serving that account's hostname. A ClawBox AI token still on the box keeps
 * its tunnel.
 */
export async function DELETE() {
  try {
    const wasLinked = await unlinkSubscription();
    const { revokeNamedTunnelWithoutAccount } = await import("@/lib/portal-heartbeat");
    const tunnelRevoked = await revokeNamedTunnelWithoutAccount("the subscription was unlinked from this box");
    return NextResponse.json({ linked: false, wasLinked, tunnelRevoked }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[subscription-link] unlink failed:", err instanceof Error ? err.name : "unknown error");
    return NextResponse.json(
      { error: "This box could not remove the subscription link. Check the device's storage and try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const dynamic = "force-dynamic";

import { openclawIsAbsent } from "@/lib/openclaw-config";
import { gatewayMessage, noStore, refuse } from "@/lib/phone-pairing-http";
import { inviteViews, listPhoneDevices, phonePairingHost, readPhonePairingEnabled } from "@/lib/phone-pairing";
import type { PhonesState } from "@/lib/phone-pairing-shared";
import { requireSession } from "@/lib/route-auth";

/**
 * GET /setup-api/nodes — the owner's Phones list (Settings → Phones).
 *
 * `{ available, enabled, host, invites, requests, approved, paired, pending }`
 * (src/lib/phone-pairing-shared.ts `PhonesState`): the switch, the box's
 * permanent link, the QR invites still open, the phones that asked and wait
 * for the owner, the approved phones still collecting their code, and — from
 * the core's own `device.pair.list` — the paired phones and any phone request
 * the gateway itself is holding. A gateway that cannot be asked leaves
 * `paired`/`pending` null with `gatewayError`, never an empty list that would
 * read as "no phones". Owner only: invite links are in it.
 */
export async function GET(request: Request) {
  const denied = await requireSession(request, { ownerOnly: true });
  if (denied) return denied;

  if (openclawIsAbsent()) {
    const state: PhonesState = {
      available: false,
      enabled: false,
      host: null,
      invites: [],
      requests: [],
      approved: [],
      paired: [],
      pending: [],
    };
    return noStore(state);
  }

  const [enabled, host] = await Promise.all([readPhonePairingEnabled(), phonePairingHost()]);
  let views: ReturnType<typeof inviteViews>;
  try {
    views = inviteViews(host);
  } catch (err) {
    console.error("[nodes] the invite store could not be read:", gatewayMessage(err));
    return refuse(500, "store_read_failed", "The phone invites could not be read from this ClawBox's data folder.");
  }
  const state: PhonesState = { available: true, enabled, host, ...views, paired: null, pending: null };
  try {
    const devices = await listPhoneDevices({ poll: true });
    state.paired = devices.paired;
    state.pending = devices.pending;
  } catch (err) {
    state.gatewayError = gatewayMessage(err);
  }
  return noStore(state);
}

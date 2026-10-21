export const dynamic = "force-dynamic";

import { noStore, ownerGate, refuse } from "@/lib/phone-pairing-http";
import {
  InviteStateError,
  createInvite,
  phoneInviteUrl,
  phonePairingHost,
  readPhonePairingEnabled,
} from "@/lib/phone-pairing";

/**
 * POST /setup-api/nodes/invite — the owner opens one QR invite.
 *
 * Answers `{ invite, url, expiresAtMs }`. The URL opens /phone-pair on the
 * box's permanent clawbox.tech link with the invite in its fragment. An invite
 * is NOT a credential for the gateway: it only lets one phone ask, and the
 * owner still approves that phone before any pairing code exists. It closes
 * after ten minutes, or once a phone has asked on it.
 */
export async function POST(request: Request) {
  const denied = await ownerGate(request, { write: true });
  if (denied) return denied;

  if (!(await readPhonePairingEnabled())) {
    return refuse(409, "switched_off", "Turn on phone pairing first.");
  }
  const host = await phonePairingHost();
  if (!host) {
    return refuse(
      409,
      "no_permanent_link",
      "Phones pair over this ClawBox's permanent clawbox.tech link, which is not running. Turn on Remote Control with a permanent link first.",
    );
  }
  // Asked again after the awaits above, with nothing awaited between this and
  // createInvite: a switch-off that landed meanwhile has already withdrawn
  // every invite, and one made now would outlive it.
  if (!(await readPhonePairingEnabled())) {
    return refuse(409, "switched_off", "Turn on phone pairing first.");
  }

  try {
    const { invite, expiresAtMs } = createInvite();
    return noStore({ invite, url: phoneInviteUrl(host, invite), expiresAtMs });
  } catch (err) {
    if (err instanceof InviteStateError) return refuse(429, err.code, err.message);
    console.error("[nodes/invite] the invite could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The invite could not be saved.");
  }
}

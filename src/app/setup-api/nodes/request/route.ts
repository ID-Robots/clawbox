export const dynamic = "force-dynamic";

import { openclawIsAbsent } from "@/lib/openclaw-config";
import { noStore, readJsonObject, refuse, requestAddress } from "@/lib/phone-pairing-http";
import { INVITE_ID_RE, InviteStateError, readPhonePairingEnabled, requestOnInvite } from "@/lib/phone-pairing";
import { cleanPhoneName, phonePlatformFromUserAgent } from "@/lib/phone-pairing-shared";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /setup-api/nodes/request `{ invite, name }` — a phone asks to pair.
 * PUBLIC (src/middleware.ts): the phone's browser has no ClawBox session.
 *
 * The invite from the owner's QR code is the only thing that lets a phone
 * ask, and one invite takes one ask. The answer is a claim the browser keeps
 * and polls `request/status` with; nothing the gateway would accept is in it.
 * The owner sees the name, the platform and the address before deciding.
 *
 * Answered only while the owner has phone pairing switched on; otherwise this
 * path does not exist (404).
 */
export async function POST(request: Request) {
  const address = requestAddress(request);
  if (!checkRateLimit("phone-pair-request", address ?? "lan", { windowMs: 60_000, max: 10 })) {
    return refuse(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }
  if (openclawIsAbsent() || !(await readPhonePairingEnabled())) {
    return refuse(404, "unavailable", "Phone pairing is not available on this ClawBox.");
  }

  const read = await readJsonObject(request);
  if (!read.ok) return read.refusal;
  const body = read.body;
  const invite = typeof body?.invite === "string" ? body.invite : "";
  if (!INVITE_ID_RE.test(invite)) return refuse(404, "unknown", "This pairing link is not valid.");

  try {
    const { claim, expiresAtMs } = requestOnInvite(invite, {
      name: cleanPhoneName(body?.name),
      platform: phonePlatformFromUserAgent(request.headers.get("user-agent")),
      address,
    });
    return noStore({ claim, expiresAtMs });
  } catch (err) {
    if (err instanceof InviteStateError) {
      const status = err.code === "used" ? 409 : err.code === "expired" ? 410 : 404;
      return refuse(status, err.code, err.message);
    }
    console.error("[nodes/request] the request could not be saved:", err instanceof Error ? err.message : err);
    return refuse(500, "store_write_failed", "The request could not be saved.");
  }
}

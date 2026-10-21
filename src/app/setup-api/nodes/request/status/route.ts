export const dynamic = "force-dynamic";

import { openclawIsAbsent } from "@/lib/openclaw-config";
import { noStore, readJsonObject, refuse, requestAddress } from "@/lib/phone-pairing-http";
import { CLAIM_RE, INVITE_ID_RE, readPhonePairingEnabled, requestStatus } from "@/lib/phone-pairing";
import { checkRateLimit } from "@/lib/rate-limit";

/**
 * POST /setup-api/nodes/request/status `{ invite, claim }` — the phone's
 * browser asks whether the owner has decided. PUBLIC (src/middleware.ts).
 *
 * `{ state: "waiting" | "approved" | "rejected" | "expired" }`. Only the
 * browser holding the claim `request` gave it learns anything, and only it is
 * ever handed the per-phone setup code — once the owner approved, until the
 * code expires. A POST rather than a GET so neither secret is in a URL.
 */
export async function POST(request: Request) {
  if (!checkRateLimit("phone-pair-status", requestAddress(request) ?? "lan", { windowMs: 60_000, max: 90 })) {
    return refuse(429, "rate_limited", "Too many attempts. Wait a minute and try again.");
  }
  if (openclawIsAbsent() || !(await readPhonePairingEnabled())) {
    return refuse(404, "unavailable", "Phone pairing is not available on this ClawBox.");
  }

  const read = await readJsonObject(request);
  if (!read.ok) return read.refusal;
  const body = read.body;
  const invite = typeof body?.invite === "string" ? body.invite : "";
  const claim = typeof body?.claim === "string" ? body.claim : "";
  if (!INVITE_ID_RE.test(invite) || !CLAIM_RE.test(claim)) {
    return refuse(404, "unknown", "This pairing request is not valid.");
  }

  const status = requestStatus(invite, claim);
  if (!status) return refuse(404, "unknown", "This pairing request is not valid.");
  return noStore(status);
}

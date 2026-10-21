export const dynamic = "force-dynamic";

import { gatewayMessage, idField, noStore, ownerGate, readJsonObject, refuse } from "@/lib/phone-pairing-http";
import { INVITE_ID_RE, InviteStateError, NotAPhoneError, rejectInvite, rejectPendingPhone } from "@/lib/phone-pairing";

/**
 * POST /setup-api/nodes/reject — the owner says no to one phone.
 *
 *  - `{ invite }`: a phone that asked from the QR link is told no (its page
 *    says so), or an invite nobody used yet is closed. No code is ever minted.
 *  - `{ requestId }`: a phone request the gateway holds: `device.pair.reject`.
 */
export async function POST(request: Request) {
  const denied = await ownerGate(request, { write: true });
  if (denied) return denied;

  const read = await readJsonObject(request);
  if (!read.ok) return read.refusal;
  const body = read.body;
  const invite = idField(body, "invite", 64);
  const requestId = idField(body, "requestId");
  if ((invite ? 1 : 0) + (requestId ? 1 : 0) !== 1 || (invite && !INVITE_ID_RE.test(invite))) {
    return refuse(400, "bad_body", "Name exactly one phone: an invite or a requestId.");
  }

  if (requestId) {
    try {
      await rejectPendingPhone(requestId);
    } catch (err) {
      if (err instanceof NotAPhoneError) return refuse(404, "not_a_phone", err.message);
      return refuse(502, "gateway_refused", `The phone was not refused: ${gatewayMessage(err)}`);
    }
    return noStore({ ok: true, requestId });
  }

  try {
    rejectInvite(invite as string);
  } catch (err) {
    if (err instanceof InviteStateError) return refuse(err.code === "unknown" ? 404 : 409, err.code, err.message);
    throw err;
  }
  return noStore({ ok: true, invite });
}

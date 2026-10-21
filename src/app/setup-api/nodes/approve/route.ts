export const dynamic = "force-dynamic";

import { gatewayMessage, idField, noStore, ownerGate, readJsonObject, refuse } from "@/lib/phone-pairing-http";
import {
  INVITE_ID_RE,
  InviteStateError,
  NotAPhoneError,
  SetupCodeRefusedError,
  approveAsk,
  approvePendingPhone,
  mintPhoneSetupCode,
  pendingAsk,
  phonePairingHost,
  readPhonePairingEnabled,
} from "@/lib/phone-pairing";

/**
 * POST /setup-api/nodes/approve — the owner approves ONE phone.
 *
 *  - `{ invite }`: a phone that asked from the QR link. Only now is its
 *    pairing code minted — the core's `device.pair.setupCode`, a single-use,
 *    ten-minute bootstrap with limited (non-admin) operator access — checked
 *    to carry nothing but that phone's bootstrap and never the box's shared
 *    key, and kept for the browser that asked to collect.
 *  - `{ requestId }`: a phone request the gateway itself is holding (a
 *    pairing the core did not admit on its own): the core's
 *    `device.pair.approve`.
 *
 * A code the check refuses is a 500 and nothing is handed out.
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
      await approvePendingPhone(requestId);
    } catch (err) {
      if (err instanceof NotAPhoneError) return refuse(404, "not_a_phone", err.message);
      return refuse(502, "gateway_refused", `The phone was not approved: ${gatewayMessage(err)}`);
    }
    return noStore({ ok: true, requestId });
  }

  if (!(await readPhonePairingEnabled())) return refuse(409, "switched_off", "Phone pairing is switched off.");
  try {
    pendingAsk(invite as string);
  } catch (err) {
    if (err instanceof InviteStateError) return refuse(err.code === "unknown" ? 404 : 409, err.code, err.message);
    throw err;
  }
  const host = await phonePairingHost();
  if (!host) {
    return refuse(409, "no_permanent_link", "The permanent clawbox.tech link is not running, so the phone could not reach this box.");
  }

  let minted;
  try {
    minted = await mintPhoneSetupCode(host);
  } catch (err) {
    if (err instanceof SetupCodeRefusedError) {
      console.error("[nodes/approve] refused to hand out the gateway's setup code:", err.message);
      return refuse(500, "unsafe_setup_code", err.message);
    }
    return refuse(502, "gateway_refused", `No pairing code could be made: ${gatewayMessage(err)}`);
  }

  try {
    approveAsk(invite as string, minted);
  } catch (err) {
    if (err instanceof InviteStateError) return refuse(409, err.code, err.message);
    throw err;
  }
  return noStore({ ok: true, invite, expiresAtMs: minted.expiresAtMs });
}

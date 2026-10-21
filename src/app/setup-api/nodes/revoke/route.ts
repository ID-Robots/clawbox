export const dynamic = "force-dynamic";

import { gatewayMessage, idField, noStore, ownerGate, readJsonObject, refuse } from "@/lib/phone-pairing-http";
import { NotAPhoneError, revokePhone } from "@/lib/phone-pairing";

/**
 * POST /setup-api/nodes/revoke `{ deviceId }` — the owner cuts one paired
 * phone off.
 *
 * The core's own `device.pair.remove`: the phone's pairing record and every
 * token it held are deleted and its live sockets disconnected, so it can
 * neither reconnect nor re-pair without a new, owner-approved code. Only a
 * phone the Phones list shows can be removed here — never one of the box's own
 * devices. Answered whether or not phone pairing is switched on: the switch
 * must never be what keeps the owner from revoking a phone.
 */
export async function POST(request: Request) {
  const denied = await ownerGate(request, { write: true });
  if (denied) return denied;

  const read = await readJsonObject(request);
  if (!read.ok) return read.refusal;
  const deviceId = idField(read.body, "deviceId");
  if (!deviceId) return refuse(400, "bad_body", "deviceId must name a paired phone.");

  try {
    await revokePhone(deviceId);
  } catch (err) {
    if (err instanceof NotAPhoneError) return refuse(404, "not_a_phone", err.message);
    console.error("[nodes/revoke] the gateway did not remove the phone:", gatewayMessage(err));
    return refuse(502, "gateway_refused", `The phone was not revoked: ${gatewayMessage(err)}`);
  }
  return noStore({ ok: true, deviceId });
}

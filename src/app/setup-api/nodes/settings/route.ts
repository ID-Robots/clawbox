export const dynamic = "force-dynamic";

import { set } from "@/lib/config-store";
import { gatewayMessage, noStore, ownerGate, readJsonObject, refuse } from "@/lib/phone-pairing-http";
import { applyPhonePairingSwitch, closeAllInvites } from "@/lib/phone-pairing";
import { PHONE_PAIRING_CONFIG_KEY } from "@/lib/phone-pairing-shared";

/**
 * POST /setup-api/nodes/settings `{ enabled }` — the owner's phone-pairing
 * switch. OFF until the owner turns it on.
 *
 * On: the gateway is first told to trust the box's own upgrade proxy
 * (`gateway.trustedProxies` gains loopback, through the core's `config set`),
 * because the phone link sends each phone's real address and the gateway
 * refuses that from a proxy it does not trust; then the switch is saved, which
 * opens /phone-ws in production-server.js. A trust write that fails leaves the
 * switch off.
 *
 * Off: the switch is saved FIRST — that closes the phone link at once — then
 * every open invite and uncollected code is withdrawn and the trusted proxies
 * this switch added are taken back out. Paired phones stay paired and stay in
 * the list for the owner to revoke; they reconnect when the switch is back on.
 */
export async function POST(request: Request) {
  const denied = await ownerGate(request, { write: true });
  if (denied) return denied;

  const read = await readJsonObject(request);
  if (!read.ok) return read.refusal;
  const enabled = read.body?.enabled;
  if (typeof enabled !== "boolean") return refuse(400, "bad_body", "enabled must be true or false.");

  if (enabled) {
    try {
      await applyPhonePairingSwitch(true);
    } catch (err) {
      console.error("[nodes/settings] the gateway's trusted proxies could not be set:", gatewayMessage(err));
      return refuse(502, "gateway_config_failed", `Phone pairing was not switched on: ${gatewayMessage(err)}`);
    }
  }

  try {
    await set(PHONE_PAIRING_CONFIG_KEY, enabled);
  } catch (err) {
    console.error("[nodes/settings] the switch could not be saved:", gatewayMessage(err));
    return refuse(500, "store_write_failed", "The switch could not be saved — the ClawBox settings file could not be written.");
  }

  if (!enabled) {
    // A withdrawal that failed is said, never answered as success: the invites
    // and codes it left open would be live again the moment the switch is back on.
    let withdrawn = true;
    try {
      closeAllInvites();
    } catch (err) {
      withdrawn = false;
      console.error("[nodes/settings] open invites could not be withdrawn:", gatewayMessage(err));
    }
    const notWithdrawn = withdrawn ? "" : " (open invites and uncollected codes could not be withdrawn either)";
    try {
      await applyPhonePairingSwitch(false);
    } catch (err) {
      console.error("[nodes/settings] the gateway's trusted proxies could not be restored:", gatewayMessage(err));
      return refuse(
        502,
        "gateway_config_failed",
        `Phone pairing is off and the phone link is closed, but the gateway's trusted proxies could not be restored: ${gatewayMessage(err)}${notWithdrawn}`,
      );
    }
    if (!withdrawn) {
      return refuse(
        500,
        "withdrawal_failed",
        "Phone pairing is off and the phone link is closed, but open invites and uncollected codes could not be withdrawn — the pairing store could not be written. They expire on their own within ten minutes; leave phone pairing off until then.",
      );
    }
  }

  return noStore({ ok: true, enabled });
}

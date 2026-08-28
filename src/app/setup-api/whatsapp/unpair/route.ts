import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { whatsappSessionDirs } from "@/lib/hermes-whatsapp";
import { unpairWhatsapp } from "@/lib/whatsapp-pairing";
import { restartGateway } from "@/lib/openclaw-config";
import { logoutOpenclawWhatsapp, setOpenclawWhatsappEnabled } from "@/lib/openclaw-whatsapp";

export const dynamic = "force-dynamic";

/**
 * Unlink the device.
 *
 * Clears the stored linked-device credentials and turns the channel off in the
 * same operation. Both have to happen together: creds without the env var is a
 * channel that will not start, and the env var without creds is a gateway that
 * retries a bridge with nothing to authenticate as.
 *
 * This removes the session from the ClawBox only. The linked-device entry on
 * the phone stays until the owner removes it in WhatsApp → Linked Devices,
 * which is the honest thing to tell them rather than implying a remote revoke.
 */
export async function POST() {
  try {
    const harness = await getActiveHarness();

    if (harness !== "hermes") {
      // Config first, destructive step second — the same ordering rule
      // setDiscordToken follows. A failed config write must not come after a
      // session that is already gone: that would leave the channel enabled
      // with nothing to authenticate as, which is the half-applied state this
      // route exists to avoid. This way the worst case is a channel switched
      // off with its session intact, which the owner can simply re-enable.
      await setOpenclawWhatsappEnabled(false);

      // The logout still has to happen, and its failure is reported rather
      // than swallowed — but the channel is already off, so a gateway that
      // cannot drop the session is not left retrying a login with it.
      let logoutError: unknown = null;
      try {
        await logoutOpenclawWhatsapp();
      } catch (err) {
        logoutError = err;
      }
      await restartGateway().catch((err) => {
        console.error("[whatsapp/unpair] gateway restart failed:", err);
      });
      if (logoutError) throw logoutError;
      console.info("[whatsapp/unpair] logged out and disabled the channel");
      return NextResponse.json({ success: true });
    }

    await unpairWhatsapp(whatsappSessionDirs());
    console.info("[whatsapp/unpair] cleared session and disabled channel");
    return NextResponse.json({ success: true });
  } catch (err) {
    // Same contract as /whatsapp/pair: a code the panel can translate, and the
    // real EPERM/ENOENT in the server log where support can read it.
    console.error("[whatsapp/unpair] failed:", err);
    return NextResponse.json({ error: "unpair_failed" }, { status: 500 });
  }
}

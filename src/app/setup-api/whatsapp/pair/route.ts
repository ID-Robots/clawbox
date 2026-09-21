import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { getPairingManager } from "@/lib/whatsapp-pairing";
import { getOpenclawWhatsappPairing } from "@/lib/openclaw-whatsapp";

export const dynamic = "force-dynamic";

/**
 * Pairing session control.
 *
 * POST   start (or re-join) a session; `{ force: true }` re-pairs over an
 *        existing link, the same prompt `hermes whatsapp` shows at step 5.
 * GET    poll the snapshot. Every GET renews the session's keepalive, so the
 *        panel being open is what keeps the bridge alive — and closing it is
 *        what reaps the bridge, without the client having to promise anything.
 * DELETE cancel. Stops the bridge; never touches creds.json.
 *
 * The snapshot carries live pairing material — the raw Baileys QR payload on
 * Hermes, a rendered PNG of the same nonce on OpenClaw. Neither is a secret in
 * the credential sense (both are short-lived and single-use), but both are
 * enough to link a device, so this route stays behind the same session gate as
 * the rest of /setup-api/whatsapp (src/middleware.ts) and neither is ever
 * logged.
 */

/**
 * The pairing session for whichever harness is active.
 *
 * Both managers expose the same `start`/`poll`/`stop` contract and the same
 * phases, so this route reads identically on either. What differs is only what
 * is underneath: a Baileys bridge this repo spawns (Hermes), or the gateway's
 * own `web.login.*` RPC (OpenClaw).
 */
async function activePairing() {
  const harness = await getActiveHarness();
  return harness === "hermes" ? getPairingManager() : getOpenclawWhatsappPairing();
}

export async function POST(request: Request) {
  try {
    const pairing = await activePairing();

    let force = false;
    try {
      const body = await request.json();
      force = body?.force === true;
    } catch {
      // A bodyless start is the common case, not an error.
    }

    const snapshot = await pairing.start({ force });
    return NextResponse.json({ supported: true, ...snapshot });
  } catch (err) {
    // Machine-readable code out, real cause to the server log. The panel maps
    // these codes to translated text and never shows the raw string, so
    // echoing an exception message only ever leaked paths and syscall names
    // to whoever holds the session cookie.
    console.error("[whatsapp/pair] start failed:", err);
    return NextResponse.json({ error: "start_failed" }, { status: 500 });
  }
}

export async function GET() {
  try {
    return NextResponse.json({ supported: true, ...(await activePairing()).poll() });
  } catch (err) {
    console.error("[whatsapp/pair] status read failed:", err);
    return NextResponse.json({ error: "status_failed" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    return NextResponse.json({ supported: true, ...(await activePairing()).stop() });
  } catch (err) {
    console.error("[whatsapp/pair] cancel failed:", err);
    return NextResponse.json({ error: "cancel_failed" }, { status: 500 });
  }
}

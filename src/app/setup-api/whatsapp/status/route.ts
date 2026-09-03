import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hermesGatewayStatus } from "@/lib/hermes-telegram";
import { readHermesWhatsappStatus } from "@/lib/hermes-whatsapp";
import { readOpenclawWhatsappStatus } from "@/lib/openclaw-whatsapp";

export const dynamic = "force-dynamic";

// The env/session reads are plain stat+read calls and cost nothing, but
// `hermes gateway status` shells out (~2 s on a Jetson) and the Settings panel
// polls this route. Cache the CLI half only, and coalesce concurrent callers
// onto one in-flight probe — the same shape the Telegram status route uses.
/**
 * The gateway probe lives in `hermesGatewayStatus()`, not here.
 *
 * This route used to keep its own 15 s memo of it. So did the Telegram and
 * Discord status routes — three private copies of one ~2 s CLI cold start,
 * which a cold Settings → Channels open ran concurrently. The dedup now sits
 * at the one place that runs the command, together with the short failure TTL
 * and the invalidation the gateway restart paths call; a copy here would
 * shadow all three, and did: after a save restarted the gateway this panel
 * kept being told about the pre-restart process until the local cache aged out.
 */
async function probeGateway(): Promise<{ installed: boolean; running: boolean }> {
  try {
    const status = await hermesGatewayStatus();
    return { installed: status.installed, running: status.running };
  } catch {
    // A wedged or missing CLI must not turn into a 500 for the whole panel;
    // report "not running" and let the state below stay honest about it.
    return { installed: false, running: false };
  }
}

export async function GET() {
  try {
    const harness = await getActiveHarness();

    // OpenClaw: the channel is the @openclaw/whatsapp plugin, and the gateway
    // is what knows about it. This branch used to answer `supported: false` on
    // the reasoning that "none of it is verifiable from a ClawBox build" —
    // true before `openclaw gateway call` gave us the plugin's own login and
    // status surfaces non-interactively. See src/lib/openclaw-whatsapp.ts.
    if (harness !== "hermes") {
      const status = await readOpenclawWhatsappStatus();
      return NextResponse.json({
        supported: true,
        harness,
        ...status,
        // OpenClaw admits senders through its own owner-approved pairing, so
        // there is no allowlist for the panel to offer and no mode to pick —
        // exactly as on the Discord panel.
        allowlistSupported: false,
        mode: null,
        allowedUsers: [],
        allowAllUsers: false,
        // The same rule as the Hermes branch below: "receiving" may be true
        // ONLY when the transport is genuinely up. A stored link and an enabled
        // channel are not evidence that anything reaches the owner's phone.
        receiving: status.connected,
        // `status.verified` is false when the gateway could not be asked at
        // all. Without it the panel cannot tell that answer apart from a real
        // "no such channel" and draws "Not configured" over a paired phone.
      });
    }

    const [status, gateway] = await Promise.all([readHermesWhatsappStatus(), probeGateway()]);

    return NextResponse.json({
      supported: true,
      harness,
      ...status,
      gateway,
      // WhatsApp is only LIVE when it is enabled, paired, something is running
      // to receive messages, AND the gateway's own sender allowlist lets the
      // owner through. Any one of the four missing means the owner's phone gets
      // silence, so all four have to hold before the UI is allowed to say
      // "active". Authorization is the one that used to be missing here: a box
      // could report itself active while the gateway dropped every message it
      // received with "Unauthorized user".
      receiving: status.state === "paired" && gateway.running && status.authorized,
      // The Hermes reader works off config plus `hermes gateway status`; if it
      // had not answered we would be in the catch below, not here.
      verified: true,
    });
  } catch (err) {
    // Fixed string out, real cause to the log — the same contract the other
    // three WhatsApp routes follow. An unreadable ~/.hermes/.env surfaces here
    // as an EACCES whose message carries the absolute path.
    console.error("[whatsapp/status] status check failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}

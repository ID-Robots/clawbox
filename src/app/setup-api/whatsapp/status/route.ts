import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { hermesGatewayStatus } from "@/lib/hermes-telegram";
import { readHermesWhatsappStatus } from "@/lib/hermes-whatsapp";

export const dynamic = "force-dynamic";

// The env/session reads are plain stat+read calls and cost nothing, but
// `hermes gateway status` shells out (~2 s on a Jetson) and the Settings panel
// polls this route. Cache the CLI half only, and coalesce concurrent callers
// onto one in-flight probe — the same shape the Telegram status route uses.
const GATEWAY_PROBE_TTL = 15_000;
let cachedGateway: { value: { installed: boolean; running: boolean }; at: number } | null = null;
let inFlightGateway: Promise<{ installed: boolean; running: boolean }> | null = null;

async function probeGateway(): Promise<{ installed: boolean; running: boolean }> {
  if (cachedGateway && Date.now() - cachedGateway.at < GATEWAY_PROBE_TTL) {
    return cachedGateway.value;
  }
  if (inFlightGateway) return inFlightGateway;
  const pending = (async () => {
    let value: { installed: boolean; running: boolean };
    try {
      const status = await hermesGatewayStatus();
      value = { installed: status.installed, running: status.running };
    } catch {
      // A wedged or missing CLI must not turn into a 500 for the whole panel;
      // report "not running" and let the state below stay honest about it.
      value = { installed: false, running: false };
    }
    // Cache the failure exactly like the success. Caching only the happy path
    // meant that the slower the CLI got, the more often the panel paid for it:
    // a wedged `hermes gateway status` costs ~2 s and the panel polls this
    // route, so every poll re-ran the shell-out it had just given up on.
    cachedGateway = { value, at: Date.now() };
    return value;
  })().finally(() => {
    inFlightGateway = null;
  });
  inFlightGateway = pending;
  return pending;
}

export async function GET() {
  try {
    const harness = await getActiveHarness();

    // OpenClaw documents a WhatsApp channel, but it is a separately-installed
    // plugin whose only login path is an interactive QR command, and none of it
    // is verifiable from a ClawBox build. Writing a channels.whatsapp block we
    // have never seen a gateway accept is the one genuinely dangerous option:
    // OpenClaw refuses to start on ANY unknown key, so a wrong guess here would
    // silently take Telegram down with it. Report the honest state instead.
    if (harness !== "hermes") {
      return NextResponse.json({
        supported: false,
        harness,
        state: "unsupported",
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
    });
  } catch (err) {
    // Fixed string out, real cause to the log — the same contract the other
    // three WhatsApp routes follow. An unreadable ~/.hermes/.env surfaces here
    // as an EACCES whose message carries the absolute path.
    console.error("[whatsapp/status] status check failed:", err);
    return NextResponse.json({ error: "Status check failed" }, { status: 500 });
  }
}

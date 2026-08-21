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
    try {
      const status = await hermesGatewayStatus();
      const value = { installed: status.installed, running: status.running };
      cachedGateway = { value, at: Date.now() };
      return value;
    } catch {
      // A wedged or missing CLI must not turn into a 500 for the whole panel;
      // report "not running" and let the state below stay honest about it.
      return { installed: false, running: false };
    }
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
      // WhatsApp is only LIVE when it is enabled, paired, AND something is
      // running to receive messages. Any one of the three missing means the
      // owner's phone gets silence, so all three have to hold before the UI is
      // allowed to say "active".
      receiving: status.state === "paired" && gateway.running,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status check failed" },
      { status: 500 },
    );
  }
}

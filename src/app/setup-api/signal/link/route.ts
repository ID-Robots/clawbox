import { NextResponse } from "next/server";
import { previewGate } from "@/lib/guided-channel-routes";
import {
  type SignalLinkState,
  cancelSignalLink,
  findSignalCli,
  readSignalLink,
  startSignalLink,
} from "@/lib/signal-cli";

export const dynamic = "force-dynamic";

// Linking a Signal account to the box: POST shows a QR code (the provisioning
// URI signal-cli prints), GET polls for the phone's answer, DELETE abandons it.
// The URI is a one-time credential, so it is only ever sent to this
// session-gated route's caller and never logged.

/** The name the box shows up under in Signal → Linked devices. */
const DEVICE_NAME = "ClawBox";

function body(state: SignalLinkState) {
  switch (state.state) {
    case "waiting":
      return { state: "waiting", uri: state.uri };
    case "linked":
      return { state: "linked", account: state.account || null };
    case "failed":
      return { state: "failed", reason: state.reason };
    default:
      return { state: "idle" };
  }
}

export async function POST() {
  const gate = previewGate("signal");
  if (gate) return gate;
  const cliPath = await findSignalCli();
  if (!cliPath) {
    return NextResponse.json(
      { error: "signal-cli is not installed on this box", code: "signal_cli_missing" },
      { status: 409 },
    );
  }
  return NextResponse.json(body(startSignalLink(cliPath, DEVICE_NAME)));
}

export async function GET() {
  const gate = previewGate("signal");
  if (gate) return gate;
  return NextResponse.json(body(readSignalLink()));
}

export async function DELETE() {
  const gate = previewGate("signal");
  if (gate) return gate;
  return NextResponse.json(body(cancelSignalLink()));
}

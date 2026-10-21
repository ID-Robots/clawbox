import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import { setSignalAccount } from "@/lib/openclaw-config";
import { type ChannelPluginFailure, ensureChannelPlugin } from "@/lib/openclaw-channels";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  GUIDED_CHANNELS,
  applyChannelRestart,
  scrubSecrets,
  settleChannelSave,
} from "@/lib/guided-channels";
import { previewGate } from "@/lib/guided-channel-routes";
import {
  SIGNAL_DAEMON_URL,
  findSignalCli,
  isE164,
  listSignalAccounts,
  signalDaemonReachable,
} from "@/lib/signal-cli";

export const dynamic = "force-dynamic";

const LOG_TAG = "signal/configure";

// Signal (a preview channel) on either edition, for an account signal-cli on
// this box already holds — linked from the pane's QR code, or by hand.
//
//   * The account is checked against signal-cli's own `listAccounts` before
//     anything is written: a number the box cannot speak as is a channel that
//     can never start.
//   * OpenClaw: the official @openclaw/signal plugin, then channels.signal with
//     a managed-native transport — the gateway starts signal-cli itself.
//   * Hermes: SIGNAL_HTTP_URL and SIGNAL_ACCOUNT. Neither passes Hermes' own
//     `config set` routing to .env (no _TOKEN/_SECRET suffix), so they go
//     through hermes-env.ts, as the WhatsApp keys do. Hermes connects to a
//     signal-cli HTTP daemon it does not start; until the box runs one, the
//     save says exactly that instead of claiming the channel is live.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const gate = previewGate("signal");
  if (gate) return gate;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const account = isRecord(body) && typeof body.account === "string" ? body.account.replace(/[\s()-]/g, "") : "";
    if (!isE164(account)) {
      return NextResponse.json(
        { error: "Enter the number in international format, starting with +", code: "account_format" },
        { status: 400 },
      );
    }

    const cliPath = await findSignalCli();
    if (!cliPath) {
      return NextResponse.json(
        { error: "signal-cli is not installed on this box", code: "signal_cli_missing" },
        { status: 409 },
      );
    }
    const accounts = await listSignalAccounts(cliPath);
    if (accounts === null) {
      return NextResponse.json(
        { error: "signal-cli could not be asked which accounts it holds", code: "signal_cli_unavailable" },
        { status: 502 },
      );
    }
    if (!accounts.includes(account)) {
      return NextResponse.json(
        { error: "signal-cli on this box has no account for that number", code: "signal_account_unknown" },
        { status: 400 },
      );
    }

    const harness = await getActiveHarness();
    await set("signal_account", account);

    let installFailure: ChannelPluginFailure | null = null;
    if (harness === "hermes") {
      await setHermesEnvValues({ SIGNAL_HTTP_URL: SIGNAL_DAEMON_URL, SIGNAL_ACCOUNT: account });
    } else {
      const plugin = await ensureChannelPlugin(GUIDED_CHANNELS.signal.openclawId);
      if (!plugin.ok) installFailure = plugin.reason;
      await setSignalAccount(account, cliPath);
    }

    const restarted = await applyChannelRestart(harness, [], LOG_TAG);
    let blocking: string | undefined = await settleChannelSave(harness, "signal", restarted, installFailure);
    if (harness === "hermes" && blocking === undefined && !(await signalDaemonReachable())) {
      blocking = "signal_daemon_unreachable";
    }

    return NextResponse.json({
      success: blocking === undefined,
      ...(blocking === undefined ? {} : { code: blocking }),
      restarted,
      account,
    });
  } catch (err) {
    console.error(`[${LOG_TAG}] failed:`, scrubSecrets(err, []));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

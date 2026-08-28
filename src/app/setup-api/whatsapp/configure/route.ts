import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { ensureHermesGateway } from "@/lib/hermes-telegram";
import { ensureChannelPlugin, waitForChannelConnected } from "@/lib/openclaw-channels";
import { restartGateway } from "@/lib/openclaw-config";
import {
  WHATSAPP_CHANNEL_ID,
  setOpenclawWhatsappEnabled,
} from "@/lib/openclaw-whatsapp";
import {
  isWhatsappMode,
  normalizeWhatsappNumber,
  setHermesWhatsappConfig,
  WhatsappNotPairedError,
  type WhatsappConfigResult,
  type WhatsappConfigUpdate,
} from "@/lib/hermes-whatsapp";

export const dynamic = "force-dynamic";

// Guard rails, not policy: a caller can send at most this many numbers so a
// pasted address book can't turn into a multi-kilobyte .env line.
const MAX_ALLOWED_USERS = 64;

interface ConfigureBody {
  allowedUsers?: unknown;
  mode?: unknown;
  enabled?: unknown;
}

/** Bounce the gateway; report rather than throw when it will not. */
async function applyRestart(): Promise<boolean> {
  try {
    await restartGateway();
    return true;
  } catch (err) {
    // The config change is already on disk, so a service failure is a warning
    // rather than a failed save — the contract every channel route here shares.
    console.error("[whatsapp/configure] gateway restart failed:", err);
    return false;
  }
}

/**
 * The OpenClaw leg.
 *
 * Two things are genuinely different from Hermes and both are refusals rather
 * than silent no-ops:
 *
 *  * there is no allowlist and no mode. OpenClaw admits senders through its own
 *    owner-approved pairing, which ClawBox does not write, so accepting numbers
 *    here would hand back a list the owner believes is in force. Same posture
 *    as /discord/configure, which reports `allowlistSupported: false`.
 *  * enabling the channel means installing its plugin first. OpenClaw's stock
 *    extensions contain no WhatsApp at all, and a `channels.whatsapp` block
 *    with no plugin to own it is the "no-channel-owner" state the Discord work
 *    was built to remove.
 *
 * And the save does not call itself a success until the gateway says the
 * channel is up — the same contract, and the same warning vocabulary, as
 * /discord/configure.
 */
async function configureOpenclaw(body: ConfigureBody): Promise<NextResponse> {
  if (body.allowedUsers !== undefined || body.mode !== undefined) {
    return NextResponse.json(
      {
        error: "allowlist_unsupported",
        code: "allowlist_unsupported",
        allowlistSupported: false,
      },
      { status: 400 },
    );
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  // Turning the channel OFF needs no plugin, no verification and no waiting:
  // the honest end state is "not receiving", and that is what it becomes.
  if (!body.enabled) {
    await setOpenclawWhatsappEnabled(false);
    const stopped = await applyRestart();
    return NextResponse.json({
      success: true,
      restarted: stopped,
      allowlistSupported: false,
      warning: stopped ? undefined : "restart_pending",
    });
  }

  const plugin = await ensureChannelPlugin(WHATSAPP_CHANNEL_ID);
  await setOpenclawWhatsappEnabled(true);

  const restarted = await applyRestart();

  const live = restarted ? await waitForChannelConnected(WHATSAPP_CHANNEL_ID) : null;

  // Root cause first, exactly as on the Discord route: a plugin that never
  // installed explains every state below it.
  const warning = !plugin.ok
    ? plugin.reason === "install_timeout"
      ? "plugin_install_timeout"
      : "plugin_install_failed"
    : !restarted
      ? "restart_pending"
      : !live
        ? "channel_unverified"
        : !live.connected
          ? "not_connected"
          : undefined;

  return NextResponse.json({
    // A WhatsApp channel that is enabled but not connected is normally waiting
    // for a QR scan, not broken — but it is still not receiving anything, and
    // this route does not get to call that a success.
    success: warning === undefined,
    ...(warning === undefined ? {} : { code: warning }),
    restarted,
    allowlistSupported: false,
    warning,
  });
}

export async function POST(request: Request) {
  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    // `request.json()` happily returns null, a number or an array — all valid
    // JSON, none of them a body. The ConfigureBody annotation is erased at
    // runtime, so without this check `body.allowedUsers` on a `null` body
    // throws a TypeError and the catch-all below turns a bad request into a
    // 500. An array is rejected too: it has no named fields to read.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    const body = parsed as ConfigureBody;

    // Pairing is a QR scan, driven by /whatsapp/pair on both harnesses. This
    // route owns access control and enablement only — it never claims to pair
    // anything.
    const harness = await getActiveHarness();
    if (harness !== "hermes") {
      return configureOpenclaw(body);
    }

    const update: WhatsappConfigUpdate = {};

    if (body.allowedUsers !== undefined) {
      if (!Array.isArray(body.allowedUsers)) {
        return NextResponse.json({ error: "allowedUsers must be an array" }, { status: 400 });
      }
      if (body.allowedUsers.length > MAX_ALLOWED_USERS) {
        return NextResponse.json(
          { error: `At most ${MAX_ALLOWED_USERS} numbers are allowed` },
          { status: 400 },
        );
      }
      const normalized: string[] = [];
      for (const entry of body.allowedUsers) {
        if (typeof entry !== "string") {
          return NextResponse.json({ error: "allowedUsers must be strings" }, { status: 400 });
        }
        const number = normalizeWhatsappNumber(entry);
        // Reject rather than silently drop: an owner who mistypes one digit
        // would otherwise see a saved allowlist that quietly excludes them.
        if (!number) {
          return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
        }
        normalized.push(number);
      }
      update.allowedUsers = normalized;
    }

    if (body.mode !== undefined) {
      if (!isWhatsappMode(body.mode)) {
        return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
      }
      update.mode = body.mode;
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      update.enabled = body.enabled;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    let result: WhatsappConfigResult;
    try {
      result = await setHermesWhatsappConfig(update);
    } catch (err) {
      if (err instanceof WhatsappNotPairedError) {
        return NextResponse.json({ error: "not_paired" }, { status: 409 });
      }
      throw err;
    }
    const { changedKeys, paired, authorized } = result;

    // Hermes' own convention for this exact operation: log which keys moved,
    // never what they were set to. The repo is public and these lines end up in
    // support bundles.
    if (changedKeys.length > 0) {
      console.info("[whatsapp/configure] updated env keys:", changedKeys.join(","));
    }

    // The failure this route exists to prevent: a box that is linked and
    // enabled, and whose gateway will still refuse the owner because nothing
    // authorizes him. setHermesWhatsappConfig keeps that from happening on any
    // write it makes, so reaching here means an allowlist we could not repair
    // -- no pairing on disk to take an identity from. Report it rather than
    // returning a bare success and letting the owner find the silence himself.
    const warning = paired && !authorized ? "no_allowed_users" : undefined;

    if (changedKeys.length === 0) {
      return NextResponse.json({ success: true, restarted: false, unchanged: true, warning });
    }

    // The gateway is the process that receives messages; a config change only
    // takes effect when it restarts. The .env write already happened, so a
    // restart failure is a warning at 200, never a failed save — same contract
    // as /telegram/configure.
    try {
      const status = await ensureHermesGateway(request.signal);
      // See /telegram/configure: `running` alone is satisfied by the pre-restart
      // process, so the new config would be reported live while unread.
      if (!status.running || !status.applied) {
        return NextResponse.json({ success: true, restarted: false, warning: warning ?? "restart_pending" });
      }
    } catch (gatewayErr) {
      console.error("[whatsapp/configure] Hermes gateway restart failed:", gatewayErr);
      return NextResponse.json({ success: true, restarted: false, warning: warning ?? "restart_pending" });
    }

    return NextResponse.json({ success: true, restarted: true, warning });
  } catch (err) {
    // Same contract as /whatsapp/pair and /whatsapp/unpair: a fixed string to
    // the client, the real cause to the server log. Filesystem failures under
    // ~/.hermes carry absolute paths and syscall names, and echoing them back
    // handed server-side detail to whoever holds the session cookie.
    console.error("[whatsapp/configure] save failed:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

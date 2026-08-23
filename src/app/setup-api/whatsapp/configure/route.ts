import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { ensureHermesGateway } from "@/lib/hermes-telegram";
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

export async function POST(request: Request) {
  try {
    let body: ConfigureBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    // Pairing is a QR scan performed by `hermes whatsapp`, a zero-flag TTY
    // wizard (see src/lib/hermes-whatsapp.ts). This route owns access control
    // and enablement only — it never claims to pair anything.
    const harness = await getActiveHarness();
    if (harness !== "hermes") {
      return NextResponse.json(
        { error: "WhatsApp is only available on the Hermes edition", supported: false },
        { status: 501 },
      );
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
      if (!status.running) {
        return NextResponse.json({ success: true, restarted: false, warning: warning ?? "restart_pending" });
      }
    } catch (gatewayErr) {
      console.error("[whatsapp/configure] Hermes gateway restart failed:", gatewayErr);
      return NextResponse.json({ success: true, restarted: false, warning: warning ?? "restart_pending" });
    }

    return NextResponse.json({ success: true, restarted: true, warning });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 },
    );
  }
}

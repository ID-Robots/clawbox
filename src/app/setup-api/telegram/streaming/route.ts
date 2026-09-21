import { NextResponse } from "next/server";
import {
  gatewayIsAbsent,
  GatewayNotReadyError,
  getTelegramProgressStreaming,
  setTelegramProgressStreaming,
  restartGateway,
} from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// Progress streaming is a property of the OPENCLAW gateway's Telegram channel:
// it lives at `channels.telegram.streaming.mode` in `~/.openclaw/openclaw.json`
// and only the gateway reads it. Hermes runs Telegram out of `~/.hermes/.env`
// (`hermes-telegram.ts`) and has no streaming concept at all.
//
// Ungated, both verbs lied on Hermes, in the two worst ways available:
//
//   GET  `readConfig()` answers `{}` for a file that does not exist, so
//        `mode !== "off"` was `undefined !== "off"` — TRUE. The switch showed
//        itself already ON before the owner touched anything.
//   POST `writeConfig()` MKDIR'd `~/.openclaw` on a box whose whole SKU is not
//        having one, wrote a setting nothing would ever read, and then called
//        `restartGateway()` — which returns immediately on Hermes
//        (`gatewayIsAbsent()`) — and answered `{success:true, restarted:true}`.
//
// `restarted: true` for a gateway that does not exist is the exact shape this
// codebase has already been bitten by. Sibling routes get this right:
// `telegram/configure` branches on the harness, `whatsapp/configure` answers
// 501 `{supported:false}` on the wrong edition. This now does the same.
const UNSUPPORTED = {
  error: "Progress streaming is an OpenClaw gateway feature; this edition does not have it.",
  supported: false,
} as const;

// Read whether the Telegram bot streams live tool/research progress while it
// works. Defaults to ON (true) when no override is set.
export async function GET() {
  if (gatewayIsAbsent()) {
    // `enabled: false` beside `supported: false` so a client that reads only
    // the flag renders an OFF switch rather than an ON one — the honest
    // fallback if it ignores the rest.
    return NextResponse.json(
      { enabled: false, ...UNSUPPORTED },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const enabled = await getTelegramProgressStreaming();
    return NextResponse.json(
      { enabled },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read setting" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  if (gatewayIsAbsent()) {
    return NextResponse.json(UNSUPPORTED, { status: 501 });
  }
  try {
    let body: { enabled?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }

    await setTelegramProgressStreaming(body.enabled);

    // The gateway only reads channel config at startup, so restart to apply.
    try {
      await restartGateway();
    } catch (err) {
      // The setting is persisted either way; what differs is whether anything
      // is coming back. Before TASK-608 this branch could only mean
      // `systemctl restart` itself failed; the readiness wait widened it to
      // "the port did not open inside the budget", which on a cold box is the
      // ordinary case — so a slow-but-healthy restart started arriving here as
      // a 502. It answers 200 now: the switch IS live within seconds, and the
      // warning says the one thing the owner needs.
      //
      // A restart that was REFUSED keeps the 502. Nothing is coming back on
      // its own there, and `SettingsApp.toggleTelegramStreaming` deliberately
      // keeps the optimistic switch position on a 502, so the warning below is
      // the only thing that tells the owner the toggle is not applied yet.
      const pending = err instanceof GatewayNotReadyError;
      return NextResponse.json(
        {
          success: true,
          restarted: false,
          warning: pending
            ? "Saved, but the gateway has not finished restarting — progress streaming applies once it is serving again."
            : "Saved, but the gateway restart failed — it'll apply on next restart.",
        },
        { status: pending ? 200 : 502 },
      );
    }

    return NextResponse.json({ success: true, restarted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 },
    );
  }
}

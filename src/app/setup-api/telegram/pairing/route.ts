import { NextResponse } from "next/server";
import { get } from "@/lib/config-store";
import {
  readTelegramAllowFrom,
  listTelegramPairingRequests,
  readTelegramPairingRequests,
  approveTelegramPairing,
  PAIRING_CODE_RE,
} from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

async function isConfigured(): Promise<boolean> {
  const token = await get("telegram_bot_token");
  return typeof token === "string" && token.length > 0;
}

// GET — list approved senders (fast: a single file read). With `?pending=1` it
// also runs `openclaw pairing list` (slow ~10-12s CLI cold-start on Jetson), so
// pending is opt-in rather than fetched on every status refresh.
export async function GET(request: Request) {
  try {
    if (!(await isConfigured())) {
      return NextResponse.json(
        { configured: false, approved: [], pending: [] },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const params = new URL(request.url).searchParams;
    const approved = await readTelegramAllowFrom();
    // `?poll=1` reads the pairing-store file (fast — safe for the desktop poller);
    // `?pending=1` uses the authoritative CLI (the Settings "Check" button).
    const pending =
      params.get("poll") === "1"
        ? await readTelegramPairingRequests()
        : params.get("pending") === "1"
          ? await listTelegramPairingRequests()
          : [];
    return NextResponse.json(
      { configured: true, approved, pending },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read pairing state" },
      { status: 500 },
    );
  }
}

// POST { code } — approve a pending pairing code and notify the requester.
export async function POST(request: Request) {
  try {
    let body: { code?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!PAIRING_CODE_RE.test(code)) {
      return NextResponse.json(
        { error: "Enter the 8-character pairing code from the bot's message." },
        { status: 400 },
      );
    }

    try {
      await approveTelegramPairing(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A spawn/timeout failure is an infrastructure problem (500); a non-zero
      // exit is almost always a user-recoverable expired/unknown code (400).
      if (/timed out|ENOENT|spawn/i.test(message)) {
        return NextResponse.json(
          { error: "Couldn't reach OpenClaw to approve the code. Try again in a moment." },
          { status: 500 },
        );
      }
      return NextResponse.json(
        {
          error:
            "Couldn't approve that code — it may have expired (codes last 1 hour) or already been used. Ask them to message the bot again.",
        },
        { status: 400 },
      );
    }

    const approved = await readTelegramAllowFrom();
    return NextResponse.json({ success: true, approved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approval failed" },
      { status: 500 },
    );
  }
}

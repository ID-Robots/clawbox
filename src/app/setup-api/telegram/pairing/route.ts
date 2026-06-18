import { NextResponse } from "next/server";
import { get, set } from "@/lib/config-store";
import {
  readTelegramAllowFrom,
  listTelegramPairingRequests,
  readTelegramPairingRequests,
  approveTelegramPairing,
  PAIRING_CODE_RE,
} from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

// OpenClaw's allowlist stores bare ids only. We remember the display name
// captured at approval time (ClawBox-side, in config-store) so the UI can show
// who each approved sender is.
const APPROVED_NAMES_KEY = "telegram_approved_names";

async function isConfigured(): Promise<boolean> {
  const token = await get("telegram_bot_token");
  return typeof token === "string" && token.length > 0;
}

async function readApprovedNames(): Promise<Record<string, string>> {
  const raw = await get(APPROVED_NAMES_KEY);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name === "string") out[id] = name;
  }
  return out;
}

async function buildApproved(names?: Record<string, string>): Promise<Array<{ id: string; name?: string }>> {
  const [ids, nameMap] = await Promise.all([readTelegramAllowFrom(), names ?? readApprovedNames()]);
  return ids.map((id) => ({ id, name: nameMap[id] }));
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
    const approved = await buildApproved();
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

    // Capture the requester's id + name from the pending store BEFORE approving
    // (approval removes the request, and the allowlist keeps only the id).
    let approvedId: string | undefined;
    let approvedName: string | undefined;
    try {
      const match = (await readTelegramPairingRequests()).find(
        (r) => typeof r.code === "string" && r.code.toUpperCase() === code,
      );
      if (match) {
        approvedId = match.id;
        if (match.name) approvedName = match.name;
      }
    } catch {
      // name capture is best-effort — approval still proceeds
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

    let names: Record<string, string> | undefined;
    if (approvedId && approvedName) {
      names = await readApprovedNames();
      names[approvedId] = approvedName;
      await set(APPROVED_NAMES_KEY, names);
    }
    const approved = await buildApproved(names);
    return NextResponse.json({ success: true, approved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Approval failed" },
      { status: 500 },
    );
  }
}

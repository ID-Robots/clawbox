// Route handlers the guided channels share verbatim (kept out of
// guided-channels.ts so that module stays free of next/server).

import { NextResponse } from "next/server";
import type { Harness } from "@/lib/harness";
import {
  type GuidedChannelId,
  PairingCodeFormatError,
  approveGuidedPairing,
} from "@/lib/guided-channels";
import { type PreviewChannel, isPreviewChannelEnabled } from "@/lib/channel-preview";

/**
 * 404 for every route of a preview channel this box has not switched on: the
 * flag is a gate, not just a hidden row. `null` when the channel is on.
 */
export function previewGate(channel: PreviewChannel): NextResponse | null {
  if (isPreviewChannelEnabled(channel)) return null;
  return NextResponse.json(
    { error: "This channel is a preview and is switched off on this box", code: "preview_disabled" },
    { status: 404 },
  );
}

/**
 * POST /setup-api/<channel>/pairing `{ code }` — approve the DM pairing code a
 * new sender got from the bot. 400 for a malformed code, 404 when the harness
 * did not know it (wrong, expired or already used), never the harness' own
 * error text: it can quote its argv.
 */
export async function handleGuidedPairing(
  request: Request,
  channel: GuidedChannelId,
  harness: Harness,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const code =
    typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : "";
  try {
    const approved = await approveGuidedPairing(harness, channel, code);
    return NextResponse.json({ success: true, userName: approved.userName ?? null });
  } catch (err) {
    if (err instanceof PairingCodeFormatError) {
      return NextResponse.json({ error: "Invalid pairing code", code: "invalid_code" }, { status: 400 });
    }
    if (err instanceof Error && /locked/i.test(err.message)) {
      return NextResponse.json({ error: err.message, code: "locked_out" }, { status: 429 });
    }
    console.warn(`[${channel}/pairing] approval refused:`, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Pairing code not found or expired", code: "not_found" }, { status: 404 });
  }
}

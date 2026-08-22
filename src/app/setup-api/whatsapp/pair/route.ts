import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { getPairingManager } from "@/lib/whatsapp-pairing";

export const dynamic = "force-dynamic";

/**
 * Pairing session control.
 *
 * POST   start (or re-join) a session; `{ force: true }` re-pairs over an
 *        existing link, the same prompt `hermes whatsapp` shows at step 5.
 * GET    poll the snapshot. Every GET renews the session's keepalive, so the
 *        panel being open is what keeps the bridge alive — and closing it is
 *        what reaps the bridge, without the client having to promise anything.
 * DELETE cancel. Stops the bridge; never touches creds.json.
 *
 * The snapshot carries the raw Baileys QR payload. That is not a secret in the
 * credential sense — it is a short-lived, single-use linking nonce — but it is
 * live pairing material, so this route stays behind the same session gate as
 * the rest of /setup-api/whatsapp (src/middleware.ts) and is never logged.
 */

async function requireHermes(): Promise<NextResponse | null> {
  const harness = await getActiveHarness();
  if (harness !== "hermes") {
    return NextResponse.json(
      { error: "WhatsApp is only available on the Hermes edition", supported: false },
      { status: 501 },
    );
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const blocked = await requireHermes();
    if (blocked) return blocked;

    let force = false;
    try {
      const body = await request.json();
      force = body?.force === true;
    } catch {
      // A bodyless start is the common case, not an error.
    }

    const snapshot = await getPairingManager().start({ force });
    return NextResponse.json({ supported: true, ...snapshot });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start pairing" },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const blocked = await requireHermes();
    if (blocked) return blocked;
    return NextResponse.json({ supported: true, ...getPairingManager().poll() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read pairing status" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const blocked = await requireHermes();
    if (blocked) return blocked;
    return NextResponse.json({ supported: true, ...getPairingManager().stop() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to cancel pairing" },
      { status: 500 },
    );
  }
}

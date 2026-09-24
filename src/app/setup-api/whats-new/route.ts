import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/bounded-json";
import { isSameOriginRequest } from "@/lib/same-origin";
import { WHATS_NEW_RELEASE } from "@/lib/whats-new";
import { dismissWhatsNew, readWhatsNewState } from "@/lib/whats-new-server";

export const dynamic = "force-dynamic";

/** `{"release":"4.0"}` is 17 bytes. Anything near this size is not a dismissal. */
const MAX_BODY_BYTES = 1024;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET: should the desktop show the "What's new in 4.0" card, and what should
 * its plan section offer? See `WhatsNewState` in `@/lib/whats-new`.
 */
export async function GET() {
  try {
    return NextResponse.json(await readWhatsNewState(), { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read the What's new card" },
      { status: 500, headers: NO_STORE },
    );
  }
}

/**
 * POST `{ release: "4.0" }`: the owner dismissed the card. Recorded in the
 * box's config store, so the card stays gone on every browser.
 *
 * `release` must name the card being shown. A tab from another build that
 * dismisses a different card must not dismiss this one.
 *
 * Same-origin only, like every other state-changing route a browser reaches.
 * A page on another site must not be able to spend the owner's one look at the
 * card.
 */
export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "The What's new card can only be dismissed from this ClawBox's own pages." },
      { status: 403, headers: NO_STORE },
    );
  }
  const parsed = await readJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return parsed.reason === "too_long"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413, headers: NO_STORE })
      : NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }
  if (parsed.body.release !== WHATS_NEW_RELEASE) {
    return NextResponse.json(
      { error: `release must be "${WHATS_NEW_RELEASE}"` },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    await dismissWhatsNew();
    return NextResponse.json({ ok: true, show: false }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to record the dismissal" },
      { status: 500, headers: NO_STORE },
    );
  }
}

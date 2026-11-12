export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { readFailureKind } from "@/lib/config-store";
import { readCloudProvidersView, writeHideCloudProviders } from "@/lib/cloud-providers-server";
import { personSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";

/**
 * /setup-api/settings/cloud-providers — the owner's "Hide cloud AI providers"
 * switch (src/lib/cloud-providers.ts says what it hides and its AUTO rule).
 * Both editions: the switch lives in ClawBox's own store, not in a harness.
 *
 * GET (a signed-in person; `canChange` true for the owner alone): the switch,
 * what it resolves to now, and the box's local choice (the external engine,
 * Local-only mode) Settings and the setup wizard lead with.
 *
 * POST `{ hide: boolean }` (owner only, from the owner's own browser and our
 * own page) stores the owner's choice, which then wins over AUTO either way.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function refuse(status: number, code: string, error: string): NextResponse {
  return NextResponse.json({ error, code }, { status, headers: NO_STORE });
}

export async function GET(req: Request) {
  const who = await personSession(req);
  if (!who) return refuse(403, "owner_only", "Only the box owner can see this setting.");
  // Another user signed in on a home box reaches Settings → AI providers too
  // (an organisation's staff never do: the middleware refuses them this
  // route): they get the page as the owner set it, and no switch.
  const view = await readCloudProvidersView();
  if (!view) return refuse(503, "store_unreadable", "The ClawBox settings file could not be read, so this setting is not known right now.");
  return NextResponse.json({ ...view, canChange: who.isOwner === true }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const who = await personSession(req);
  if (!who?.isOwner) {
    return refuse(403, "owner_only", "Only the box owner can hide or show the cloud AI providers, from their own browser.");
  }
  if (!isSameOriginRequest(req)) {
    return refuse(403, "cross_origin", "This setting can only be changed from this ClawBox's own pages.");
  }

  let hide: boolean;
  try {
    const parsed: unknown = await req.json();
    const candidate = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { hide?: unknown }).hide
      : undefined;
    if (typeof candidate !== "boolean") return refuse(400, "bad_body", "hide must be true or false.");
    hide = candidate;
  } catch {
    return refuse(400, "bad_body", "Invalid JSON.");
  }

  try {
    await writeHideCloudProviders(hide);
  } catch (err) {
    // The kind only, never the message: see readFailureKind.
    console.error("[cloud-providers] the switch could not be saved:", readFailureKind(err));
    return refuse(500, "store_write_failed", "The setting could not be saved — the ClawBox settings file could not be written. Nothing was changed.");
  }
  console.log(`[cloud-providers] the owner turned "hide cloud AI providers" ${hide ? "on" : "off"}`);
  const view = await readCloudProvidersView();
  if (!view) return refuse(503, "store_unreadable", "The setting was saved, but the ClawBox settings file could not be read back.");
  return NextResponse.json({ ...view, canChange: true }, { headers: NO_STORE });
}

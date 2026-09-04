export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  getBrowserAutoOpen,
  getBrowserStartUrl,
  normalizeStartUrl,
  readBrowserSetupFlag,
  setBrowserAutoOpen,
  setBrowserSetupComplete,
  setBrowserStartUrl,
  writeBrowserLaunchEnv,
} from "@/lib/browser-setup";

/**
 * What the OWNER decides about the browser app: the wizard's completion flag,
 * whether opening the app opens Chromium, and the start page.
 *
 * OWNER ONLY, like ClawKeep's and Memory Shard's setup routes: middleware
 * admits the MCP bearer on every /setup-api route, and none of these three is
 * the agent's to change — the auto-open switch in particular exists because
 * `ui_open_app("browser")` is a tool call, and a tool that could also turn the
 * switch back on would make the owner's "no" temporary.
 *
 * POST { setupComplete?, autoOpen?, startUrl? } → { setupComplete, autoOpen, startUrl }.
 */
export async function POST(request: Request) {
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the browser settings needs a signed-in browser session.", code: "owner_only" },
      { status: 403 },
    );
  }
  // And from OUR page: the cookie rides on a POST any other site fires at the
  // box, and a `text/plain` body needs no preflight (same-origin.ts).
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "The browser settings only change from this ClawBox's own pages.", code: "cross_origin" },
      { status: 403 },
    );
  }

  let body: { setupComplete?: unknown; autoOpen?: unknown; startUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body", code: "bad_body" }, { status: 400 });
  }

  if (body.setupComplete !== undefined && typeof body.setupComplete !== "boolean") {
    return NextResponse.json({ error: "Expected setupComplete to be true or false.", code: "bad_body" }, { status: 400 });
  }
  if (body.autoOpen !== undefined && typeof body.autoOpen !== "boolean") {
    return NextResponse.json({ error: "Expected autoOpen to be true or false.", code: "bad_body" }, { status: 400 });
  }
  // `null` is how the owner clears the start page back to the default; a
  // string that is not an http(s) address is a refusal, because Chromium
  // would happily open a `file://` one on the screen the agent screenshots.
  let startUrl: string | null | undefined;
  if (body.startUrl !== undefined) {
    if (body.startUrl === null || (typeof body.startUrl === "string" && body.startUrl.trim() === "")) {
      startUrl = null;
    } else {
      const normalized = normalizeStartUrl(body.startUrl);
      if (!normalized) {
        return NextResponse.json(
          { error: "The start page has to be a web address beginning with http:// or https://.", code: "bad_start_url" },
          { status: 400 },
        );
      }
      startUrl = normalized;
    }
  }

  try {
    if (typeof body.setupComplete === "boolean") await setBrowserSetupComplete(body.setupComplete);
    if (typeof body.autoOpen === "boolean") await setBrowserAutoOpen(body.autoOpen);
    if (startUrl !== undefined) {
      // Written through to the launch script now as well as at every open, so
      // a browser started by anything else — the service on boot, the agent —
      // lands where the owner just said.
      await writeBrowserLaunchEnv(await setBrowserStartUrl(startUrl));
    }
    return NextResponse.json(
      {
        setupComplete: await readBrowserSetupFlag(),
        autoOpen: await getBrowserAutoOpen(),
        startUrl: await getBrowserStartUrl(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn("[setup-api/browser/setup] could not save:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Could not save the browser settings.", code: "write_failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

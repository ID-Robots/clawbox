// Defense-in-depth gate for the OpenClaw App Store routes.
//
// The store installs OPENCLAW desktop apps: /setup-api/apps/install and
// /apps/settings and /apps/skill-info all shell out to the openclaw binary and
// reload the OpenClaw gateway. On a Hermes device neither exists, so the store
// is hidden from every UI surface (see OPENCLAW_ONLY_APP_IDS in
// src/lib/desktop-app-editions.ts, which every surface reads). This is the HTTP mirror of
// that decision — the same reasoning as hermesSkillsGuard, which refuses the
// skills routes when the active harness isn't Hermes.
//
// Deliberately NOT applied to two routes:
//   - apps/uninstall — the cleanup path, and it is NOT unreachable on Hermes:
//     the MCP tool `app_uninstall` (mcp/clawbox-mcp.ts) posts to it, so the
//     agent can still remove an app whose icon and store the UI has hidden.
//     Guarding it would strand those apps in the installedApps prefs with
//     nothing able to delete them.
//   - apps/icon/[appId] — a generic image proxy/cache; guarding it would blank
//     the icons of apps that legitimately survive on screen.
//
// On OpenClaw (and on dual with OpenClaw active) getActiveHarness() returns
// "openclaw", so this is a no-op there.

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";

// Labelled for the same reason hermesSkillsGuard's 404 is: a 404 whose JSON
// carries an `error` string is what the MCP's generic mapping reads as "the id
// you passed does not exist", and the recovery it advises — list the ids and
// call again — comes straight back through this guard. The header comment
// above already recorded that a chronically-404ing tool trips the agent's
// circuit breaker; the `code` is what lets the tool stop instead. Status and
// human-readable string unchanged.
export async function openclawAppsGuard(): Promise<NextResponse | null> {
  if ((await getActiveHarness()) !== "openclaw") {
    return NextResponse.json({ error: "Not found", code: "not_openclaw" }, { status: 404 });
  }
  return null;
}

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { commandsFromHermesCatalog } from "@/lib/chat-slash-commands";
import { getActiveHarness } from "@/lib/harness";
import { dashboardRpc } from "@/lib/hermes-dashboard-rpc";
import { requireSession } from "@/lib/route-auth";

/**
 * Hermes' own slash-command catalogue, for the chat composer's popover.
 *
 * GET → `{ commands: SlashCommand[] }`
 *
 * The catalogue is HERMES', read live over the dashboard RPC `commands.catalog`
 * — the socket `dashboardRpc` already speaks, and a method whose own contract
 * describes it as metadata "for completion menus". It derives from
 * `hermes_cli/commands.py`'s `COMMAND_REGISTRY`, which that module names as the
 * source every consumer derives from, autocomplete included. Nothing in ClawBox
 * holds a copy.
 *
 * It is a ROUTE rather than something the browser calls directly because the
 * dashboard listens on the box's loopback with a session cookie ClawBox mints;
 * the browser can no more reach it than it can reach `~/.hermes/config.yaml`.
 * The browser half is `HermesAdapter.listCommands`.
 *
 * A box whose dashboard is down answers 200 with an EMPTY list rather than an
 * error: the composer's only reaction to either is "no popover", and a 500 in
 * the browser console for a box that is merely running its CLI transport would
 * be a failure reported over a chat that works. The `available` flag says which
 * of the two it was, so a caller that wants to retry can tell them apart
 * without guessing from a length.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  // The OpenClaw edition has no dashboard at all, and asking it for one costs a
  // login attempt plus a backoff window on every keystroke that opens the menu.
  if ((await getActiveHarness()) !== "hermes") {
    return NextResponse.json({ commands: [], available: false });
  }

  const catalog = await dashboardRpc("commands.catalog", {}).catch(() => null);
  if (catalog === null || catalog === undefined) {
    return NextResponse.json({ commands: [], available: false });
  }
  return NextResponse.json({ commands: commandsFromHermesCatalog(catalog), available: true });
}

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { hasHermesHarness } from "@/lib/edition-source";
import { reloadHermesPlugins } from "@/lib/hermes-plugin-reload";
import { readHermesPluginState } from "@/lib/hermes-plugin-set";
import { requireSession } from "@/lib/route-auth";

/**
 * POST /setup-api/hermes/plugins/reload — make the running agent re-scan for
 * plugins, on purpose.
 *
 * The watcher in `src/lib/hermes-plugin-reload.ts` does this by itself when
 * `~/.hermes` changes. This is the same thing, asked for rather than noticed, and
 * it exists because of what the assistant on the owner's box did next after
 * installing a plugin: it tried `sudo systemctl restart
 * clawbox-hermes-dashboard`, was refused (agent shells run with
 * `no_new_privs`, and no such grant exists or should), and stopped there — with
 * the plugin installed, proven to work in a fresh CLI process, and invisible to
 * every chat the owner opened.
 *
 * THE AGENT IS AN INTENDED CALLER, which is unusual for a route that changes
 * device state and is deliberate here. `requireSession` admits the owner's
 * session cookie OR the MCP bearer. Refusing the bearer would leave the
 * assistant exactly where it was: able to install a plugin and unable to make it
 * work. What it is being handed is not privilege — the restart underneath is
 * `bounceHermesDashboard()`, which stops a process the clawbox user already owns
 * and lets `Restart=always` bring it back. This file names no unit, takes no
 * argument, and contains neither `sudo` nor `systemctl`; its own suite asserts
 * that last part, because the moment it did it would need a grant that
 * `install-sudoers-migration.test.ts` refuses to give — and that grant would let
 * an OpenClaw box START the dashboard its foreign-edition teardown had stopped.
 *
 * Answers `{ restarted, ready, plugins, loaded, detail }`:
 *   - `restarted` — the restart was TAKEN.
 *   - `ready`     — and the replacement is SERVING. `restarted && !ready` means
 *                   systemd owns it and it is on its way; acting again makes it
 *                   worse, so that is a 200, not an error.
 *   - `plugins`   — what the box declares now.
 *   - `loaded`    — what the REPLACEMENT proved it registered, or null when this
 *                   box could not be asked. Never an empty array standing in for
 *                   "unknown", and on most boxes it IS null: the dashboard
 *                   publishes no plugin-registration lines (measured on the
 *                   owner's device).
 *   - `stale`     — whether the process now serving chat is STILL behind the
 *                   files. `false` is the proof the restart took, and it is the
 *                   one that holds on a box where `loaded` cannot be read.
 *
 * A restart that could not be taken is a 502 rather than a 200 with a flag: the
 * caller is an agent about to tell the owner their plugin is live, and a 200 is
 * the one thing that would make it say so.
 */

export async function POST(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  // THE EDITION, NOT THE ACTIVE HARNESS. On the premium `dual` SKU the dashboard
  // runs whichever agent is serving the owner — `install.sh` enables the unit for
  // hermes AND dual — so asking which harness is active would refuse this on a
  // box that has the very process it restarts. An OpenClaw box has no dashboard
  // by design, and reaching for one there would be this route starting a unit the
  // foreign-edition teardown deliberately stopped and disabled.
  if (!hasHermesHarness()) {
    return NextResponse.json(
      {
        error: "This ClawBox does not run the Hermes agent, so it has no plugins to reload.",
        code: "no_hermes_dashboard",
      },
      { status: 404 },
    );
  }

  const result = await reloadHermesPlugins("a reload was requested through /setup-api");
  const body = {
    restarted: result.restarted,
    ready: result.ready,
    plugins: result.plugins,
    loaded: result.loaded,
    stale: result.stale,
    detail: result.detail,
  };
  return NextResponse.json(body, {
    status: result.restarted ? 200 : 502,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * GET — the same two facts, without restarting anything.
 *
 * "Installed" and "loaded" are different questions (see
 * `src/lib/hermes-plugin-set.ts`), and until this existed nothing on the box
 * could answer the second. `stale` is the structural answer — the declaration
 * changed after the dashboard started, so the running process cannot have read
 * it — and it holds even for a plugin whose registrations Hermes logs below the
 * level the journal read can see.
 */
export async function GET(request: Request) {
  const unauthorized = await requireSession(request);
  if (unauthorized) return unauthorized;

  if (!hasHermesHarness()) {
    return NextResponse.json(
      {
        error: "This ClawBox does not run the Hermes agent, so it has no plugins to report.",
        code: "no_hermes_dashboard",
      },
      { status: 404 },
    );
  }

  const state = await readHermesPluginState();
  return NextResponse.json(
    {
      plugins: state.declared,
      loaded: state.loaded,
      stale: state.stale,
      dashboardStartedAt: state.dashboardStartedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

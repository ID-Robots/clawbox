export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

import { getActiveHarness } from "@/lib/harness";
import { restartGateway } from "@/lib/openclaw-config";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import {
  canonicalPluginId,
  claimPluginRepair,
  clearPluginRepairUnlessRefiled,
  pluginRepairInProgress,
  readPluginRepairs,
  setPluginRepairInProgress,
  type PluginRepairEntry,
} from "@/lib/plugin-repair";
import { currentCoreRelease, runPluginRepair } from "@/lib/plugin-repair-run";

/**
 * The Retry behind Settings → "Needs repair" (TASK-606).
 *
 * WHAT IT RUNS is the harness's own repair, not a reimplementation of one:
 * `openclaw plugins install <id> --accept-capabilities` for a row the boot
 * script could not install, and `openclaw plugins enable <id>
 * --accept-capabilities` for one it could not consent — exactly the two
 * commands `scripts/gateway-pre-start.sh` runs at boot, and exactly the two the
 * core's own documentation names for these states. This route adds the owner's
 * gesture and the bookkeeping around it; the repair itself is OpenClaw's.
 *
 * AND THE THIRD ROW (TASK-738) is where that gesture matters most. A core bump
 * strands entries an older core bundled and the installed one does not; the
 * updater switches those off so the gateway can report ready, and files them
 * with the official package the CORE named. Nothing installs them on the box's
 * own initiative — that would be consenting to a plugin's capabilities on
 * behalf of an owner who never chose it. Here it is his press, so the install
 * runs, with his consent, on the spec the core supplied.
 *
 * AND IT PROVES IT. `openclaw plugins list --json` is asked afterwards and the
 * marker is cleared only for a plugin that comes back installed AND consented.
 * A CLI that exits 0 having written nothing is the false success this whole
 * card is about: the boot script's own "gateway will still start" was one, and
 * a Retry that cleared the badge on an exit code would be the same mistake one
 * screen further out.
 *
 * OWNER ONLY. Middleware admits the MCP bearer to `/setup-api`, and this
 * installs a package from a registry and consents to its declared capabilities
 * on the owner's behalf — the same reason `coding-agent/enable` and
 * `email/pending` refuse the agent.
 *
 * HERMES: there are no plugins of this kind and nothing ever writes a marker,
 * so every id is unknown here and the route answers 404. Inert, not erroring.
 *
 * THE REPAIR ITSELF lives in `src/lib/plugin-repair-run.ts` since TASK-1088,
 * shared with the updater's after-update retry: the spec moved onto the core
 * that is on the box, a consent row whose payload is gone repaired as the
 * install it is, and the runtime asked whether the plugin loaded. This route is
 * the owner's gesture around it — the gate, the restart, and what the badge
 * does afterwards.
 */

export async function GET(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
  }
  const repairs = await readPluginRepairs();
  return NextResponse.json(
    {
      ok: true,
      repairs: Object.values(repairs).map((row) => ({
        pluginId: row.id,
        stage: row.stage,
        reason: row.reason,
        atMs: row.atMs,
        // Only while it is true, so a row nobody is repairing reads exactly as
        // it did before the field existed.
        ...(pluginRepairInProgress(row) ? { repairing: true } : {}),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
  }
  // And from OUR page. The owner's cookie rides on a POST any other site fires
  // at the box, and the owner gate above cannot tell the two apart. The marker
  // keeps the blast radius small — nothing attacker-chosen reaches an argv —
  // but this installs a package and restarts the gateway, so it gets the same
  // guard the other state-changing owner routes use (same-origin.ts).
  if (!isSameOriginRequest(req)) {
    return NextResponse.json({ ok: false, code: "cross_origin" }, { status: 403 });
  }
  if ((await getActiveHarness().catch(() => "openclaw")) === "hermes") {
    return NextResponse.json({ ok: false, code: "not_supported" }, { status: 404 });
  }

  // `null`, `[]` and `"x"` are all valid JSON, and reading `.pluginId` off any
  // of them is a throw rather than a 400.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const raw = (body as { pluginId?: unknown }).pluginId;
  const asked = typeof raw === "string" ? raw.trim() : "";
  if (!asked) {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }

  // ONLY a plugin the boot script actually marked. The id reaches an argv, and
  // the marker is the allow-list: without it this would be "install whatever
  // the caller names" behind an owner cookie.
  const repairs = await readPluginRepairs();
  const entry: PluginRepairEntry | undefined = Object.values(repairs)
    .find((row) => canonicalPluginId(row.id) === canonicalPluginId(asked));
  if (!entry) {
    return NextResponse.json({ ok: false, code: "not_marked" }, { status: 404 });
  }
  // ONE REPAIR AT A TIME (TASK-1088). A second press — another tab, a panel
  // that remounted and forgot its own "Repairing…", or the updater's
  // after-update retry already running — would start a second
  // `plugins install --force` over the first and restart the gateway under it.
  if (pluginRepairInProgress(entry)) {
    return NextResponse.json({ ok: false, code: "repair_in_progress" }, { status: 409 });
  }
  // Said ON THE ROW, not only in this tab, so every surface that draws it says
  // "Repairing…" until this answers — and CLAIMED in the same step as the fresh
  // check, so two presses that both read the row above before either wrote
  // cannot both start. Best effort past that: a row that cannot carry the stamp
  // can still be repaired.
  if ((await claimPluginRepair(entry.id).catch(() => "claimed" as const)) === "busy") {
    return NextResponse.json({ ok: false, code: "repair_in_progress" }, { status: 409 });
  }
  const ended = () => setPluginRepairInProgress(entry.id, false).catch(() => false);

  // The core that is on the box NOW, so a row written against an older one
  // installs the package built for this one (`rebaseCorePinnedSpec`).
  const verdict = await runPluginRepair(entry, { release: await currentCoreRelease() });
  if (!verdict.ok) {
    await ended();
    // Deliberately not returned as the reason: the CLI's stderr on this path
    // carries registry URLs and package specs, and the owner's next move is the
    // same whatever it says. The marker stays up.
    //
    // `repaired === null` — "unverified" — is "the box could not be asked", and
    // `harnessSaysLoaded` says why that is not "it is still broken": the
    // inspect module-loads every enabled plugin and can time out on exactly
    // the box whose gateway has just failed to come back. The runner leaves
    // the entry ON for that one here; switching it off would take a working
    // plugin down on a click that changed nothing, and for deepseek and the
    // channels no boot path puts it back.
    return NextResponse.json(
      { ok: false, code: verdict.code },
      { status: verdict.code === "no_spec" ? 409 : 502 },
    );
  }

  // AND RESTART, like every other route that installs a plugin. `plugins
  // install` prints "Restart the gateway to load plugins" for a reason: without
  // this the owner presses Retry, the badge vanishes and the provider is still
  // not connected — the badge would have been the only honest thing on screen.
  // Reported rather than folded into the verdict: the config and the store are
  // already right, and a gateway that did not come back is a different problem
  // with a different answer.
  let restarted = true;
  try {
    await restartGateway();
  } catch {
    restarted = false;
  }

  // THE BADGE GOES ONLY WHEN THE REPAIR IS COMPLETE END TO END — installed,
  // verified, switched back on AND loaded by a gateway that came back. A
  // restart that did not happen leaves a plugin that is correct on disk and
  // still not running, and "Needs repair" is the true thing to leave on screen
  // for that: the plugin loads at the next start, and the boot script's own
  // consent loop clears the row there.
  //
  // Still not an error. The repair itself did happen, and answering `ok: false`
  // would send the owner back through a 180 s reinstall for a restart problem
  // — the false failure this card exists to remove. The two facts are reported
  // separately instead, and the panel keeps the notice while `markerCleared` is
  // false rather than removing it and putting it straight back.
  if (!restarted) {
    await ended();
    return NextResponse.json({ ok: true, pluginId: entry.id, restarted, markerCleared: false });
  }
  // AND ONLY IF THE RESTART DID NOT FILE IT AGAIN (TASK-1088). The restart runs
  // the boot script, which asks the core about this plugin itself; when its
  // answer is no, it switches the plugin off again and re-files the row with
  // the cause. Clearing by id after that deleted the failure it had just
  // written — the badge went, the plugin stayed off — so the row is cleared
  // only while it is still the one this press set out to repair, and a row
  // filed again is reported as the failure it is.
  let cleared: "cleared" | "absent" | "refiled" | null;
  try {
    cleared = await clearPluginRepairUnlessRefiled(entry.id, entry.atMs);
  } catch {
    cleared = null;
  }
  if (cleared === "refiled") {
    return NextResponse.json({ ok: false, code: "refused_at_start" }, { status: 502 });
  }
  if (cleared === null) await ended();
  return NextResponse.json({ ok: true, pluginId: entry.id, restarted, markerCleared: cleared !== null });
}

export const dynamic = "force-dynamic";

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

import { NextResponse } from "next/server";

import { getActiveHarness } from "@/lib/harness";
import { runOpenclawConfigSet } from "@/lib/openclaw-config";
import { hasOwnerSession } from "@/lib/owner-session";
import {
  canonicalPluginId,
  clearPluginRepair,
  readPluginRepairs,
  type PluginRepairEntry,
} from "@/lib/plugin-repair";

const execFile = promisify(execFileCb);

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
 */

const OPENCLAW_BIN = process.env.OPENCLAW_BIN
  || `${process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox"}/.npm-global/bin/openclaw`;

/** Long enough for an npm install on a Jetson, short enough to answer a click. */
const INSTALL_TIMEOUT_MS = 180_000;
const CONSENT_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 60_000;

interface PluginListRow {
  id?: unknown;
  name?: unknown;
  installed?: unknown;
  enabled?: unknown;
  status?: unknown;
  consented?: unknown;
  capabilitiesAccepted?: unknown;
}

/**
 * Is this plugin, by the harness's own account, installed and consented?
 *
 * Null when the CLI could not be asked or its answer could not be read — never
 * `false`, because "we could not check" and "it is still broken" want different
 * words on screen and only one of them should keep a badge up.
 */
async function harnessSaysRepaired(pluginId: string): Promise<boolean | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(OPENCLAW_BIN, ["plugins", "list", "--json"], {
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const rows: PluginListRow[] = Array.isArray(parsed)
    ? (parsed as PluginListRow[])
    : Array.isArray((parsed as { plugins?: unknown })?.plugins)
      ? ((parsed as { plugins: PluginListRow[] }).plugins)
      : [];
  if (rows.length === 0) return null;
  const wanted = canonicalPluginId(pluginId);
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : null;
    if (!id || canonicalPluginId(id) !== wanted) continue;
    // The shape has moved between builds, so read every spelling that means the
    // same thing and require BOTH halves — an installed plugin whose
    // capabilities are still unconsented is the exact state that refuses
    // readiness, and calling that repaired would put the box back in the loop.
    const installed = row.installed === true || row.status === "loaded" || row.status === "installed";
    const consented = row.consented === true
      || row.capabilitiesAccepted === true
      || (row.consented === undefined && row.capabilitiesAccepted === undefined && row.enabled === true);
    return installed && consented;
  }
  return false;
}

/**
 * What still needs repair, for a panel that has no provider row to hang it on.
 *
 * The Providers strip gets the same fact stamped on its own rows by
 * `provider-status.ts` — one request instead of two for the screen that polls —
 * and the Channels list reads it here. Both call `readPluginRepairs()`, so
 * there is one file and one answer; what differs is only who asks.
 *
 * Owner-only like the POST: it names what is broken on this device, which is
 * not something the agent needs and not something to hand out on a bearer.
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
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!(await hasOwnerSession(req))) {
    return NextResponse.json({ ok: false, code: "owner_only" }, { status: 403 });
  }
  if ((await getActiveHarness().catch(() => "openclaw")) === "hermes") {
    return NextResponse.json({ ok: false, code: "not_supported" }, { status: 404 });
  }

  let body: { pluginId?: unknown };
  try {
    body = (await req.json()) as { pluginId?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "bad_request" }, { status: 400 });
  }
  const asked = typeof body.pluginId === "string" ? body.pluginId.trim() : "";
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

  const args = entry.stage === "install"
    ? ["plugins", "install", entry.id, "--accept-capabilities"]
    : ["plugins", "enable", entry.id, "--accept-capabilities"];
  try {
    await execFile(OPENCLAW_BIN, args, {
      timeout: entry.stage === "install" ? INSTALL_TIMEOUT_MS : CONSENT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // Deliberately not returned as the reason: the CLI's stderr on this path
    // carries registry URLs and package specs, and the owner's next move is the
    // same whatever it says. The marker stays up.
    return NextResponse.json({ ok: false, code: "repair_failed" }, { status: 502 });
  }

  const repaired = await harnessSaysRepaired(entry.id);
  if (repaired !== true) {
    return NextResponse.json(
      { ok: false, code: repaired === null ? "unverified" : "repair_failed" },
      { status: 502 },
    );
  }

  // PUT BACK WHAT THE BOOT SCRIPT TOOK AWAY. It set
  // `plugins.entries.<id>.enabled = false` so the gateway could start; a repair
  // that left it there would be the plainest false success this card has —
  // badge gone, plugin still never loaded. `runOpenclawConfigSet` verifies the
  // write against the file, so an unwritable config is a failure the owner is
  // told about rather than a green answer.
  //
  // `plugins enable` may already have set it: writing `true` over `true` is a
  // no-op the CLI's own non-destructive guard handles, and asking first would
  // cost a second read for nothing.
  if (entry.disabled) {
    try {
      await runOpenclawConfigSet([`plugins.entries["${entry.id}"].enabled`, "true", "--strict-json"]);
    } catch {
      return NextResponse.json({ ok: false, code: "reenable_failed" }, { status: 502 });
    }
  }

  await clearPluginRepair(entry.id).catch(() => false);
  // Installed, consented and switched back on. The gateway loads it at its next
  // start, which is what the panel tells the owner.
  return NextResponse.json({ ok: true, pluginId: entry.id, restartRequired: true });
}

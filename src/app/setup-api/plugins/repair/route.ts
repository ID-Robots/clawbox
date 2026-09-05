export const dynamic = "force-dynamic";

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

import { NextResponse } from "next/server";

import { getActiveHarness } from "@/lib/harness";
import { installDeepseekProviderPlugin } from "@/lib/openclaw-deepseek-plugin";
import { restartGateway, runOpenclawConfigSet } from "@/lib/openclaw-config";
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
const INSPECT_TIMEOUT_MS = 120_000;

interface RuntimeInspection {
  plugin?: { id?: unknown; status?: unknown; activated?: unknown };
}

/**
 * Did this plugin actually LOAD, by the harness's own account?
 *
 * `plugins list` cannot answer that. It reads a persisted discovery snapshot —
 * `{"id":"discord","enabled":true,"status":"loaded","origin":"global"}` is the
 * shape `src/lib/openclaw-channels.ts` records for a globally installed package
 * whose `plugins.entries.<id>` is missing entirely — so "the CLI can see it" is
 * the one thing the boot script never doubted, and reading `enabled` as consent
 * would clear the badge for a plugin whose capability surface is still
 * unaccepted, putting the box straight back in the readiness-refusal loop.
 *
 * `plugins inspect <id> --runtime` module-loads it and reports what happened —
 * the same command `scripts/gateway-pre-start.sh` uses to prove its own hook
 * plugin registered. It is expensive (a registry snapshot plus a module load of
 * every enabled plugin, tens of seconds on an Orin), which is why the boot path
 * gates it behind a stamp and this one does not: a person is waiting on a
 * button they pressed, and the alternative is telling them a repair happened
 * because a command exited 0.
 *
 * Null when the CLI could not be asked or its answer could not be read — never
 * `false`, because "we could not check" and "it is still broken" want different
 * words on screen and only one of them should clear a badge.
 */
async function harnessSaysLoaded(pluginId: string): Promise<boolean | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(OPENCLAW_BIN, ["plugins", "inspect", pluginId, "--runtime", "--json"], {
      timeout: INSPECT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
  let parsed: RuntimeInspection;
  try {
    parsed = JSON.parse(stdout) as RuntimeInspection;
  } catch {
    return null;
  }
  const plugin = parsed.plugin;
  if (!plugin || typeof plugin !== "object") return null;
  if (plugin.status === undefined && plugin.activated === undefined) return null;
  // BOTH, and neither inferred from the other: a plugin can be discovered
  // (`status: "loaded"`) and still refuse to activate on an unaccepted surface,
  // which is precisely the state that refuses gateway readiness.
  return plugin.status === "loaded" && plugin.activated === true;
}

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

  try {
    if (entry.stage !== "install") {
      await execFile(OPENCLAW_BIN, ["plugins", "enable", entry.id, "--accept-capabilities"], {
        timeout: CONSENT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } else if (canonicalPluginId(entry.id) === "deepseek") {
      // The DeepSeek provider has its own installer, and it is the one that
      // knows the `clawhub:` scheme and the pinned-then-unpinned order. A
      // `plugins install deepseek` here would name no scheme at all and could
      // fetch an unrelated npm package — and then accept its capabilities.
      const result = await installDeepseekProviderPlugin();
      if (!result.installed) throw new Error(result.failures.join("; "));
    } else {
      // THE SPEC THE BOOT SCRIPT USED, never the short id: `codex` resolves
      // `@latest`, drifts ahead of the pinned runtime and crashes every Codex
      // chat. A marker written before this field existed has no spec, and this
      // refuses rather than guessing one — the next boot writes a full row.
      if (!entry.spec) {
        return NextResponse.json({ ok: false, code: "no_spec" }, { status: 409 });
      }
      // `--force` because the boot path uses it and because the CLI exits 1
      // with "plugin already exists (delete it first)" otherwise — the
      // commonest repair state is a package on disk with a broken peer-dep
      // symlink, and without this the Retry could never succeed once.
      await execFile(
        OPENCLAW_BIN,
        ["plugins", "install", entry.spec, "--force", "--accept-capabilities"],
        { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
    }
  } catch {
    // Deliberately not returned as the reason: the CLI's stderr on this path
    // carries registry URLs and package specs, and the owner's next move is the
    // same whatever it says. The marker stays up.
    return NextResponse.json({ ok: false, code: "repair_failed" }, { status: 502 });
  }

  const repaired = await harnessSaysLoaded(entry.id);
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
  return NextResponse.json({ ok: true, pluginId: entry.id, restarted });
}

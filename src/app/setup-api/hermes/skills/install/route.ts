export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { checkInstallIdentifier, isValidMeta } from "@/lib/hermes-skills";
import {
  hermesSkillsGuard,
  invalidateInstalledCache,
  isInHubLock,
  resolveLockKey,
} from "@/lib/hermes-skills-server";

// Install a Hermes skill through Hermes' own CLI. Unlike the OpenClaw store,
// this does NOT touch config-store / pref:installed_apps and does NOT reload the
// gateway — Hermes skills are agent skills on disk (~/.hermes/skills), not
// desktop apps, so there's no desktop-icon coupling. The client re-fetches the
// installed list after a success.
export async function POST(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  let body: { id?: unknown; category?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";

  const idCheck = checkInstallIdentifier(id);
  if (!idCheck.ok) {
    return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  }
  if (category && !isValidMeta(category)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }
  if (name && !isValidMeta(name)) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  // `--yes` runs non-interactively. `--force` is intentionally NOT passed: a
  // non-"safe" scan verdict should block rather than be overridden here.
  const args = ["skills", "install", id, "--yes"];
  if (category) args.push("--category", category);
  if (name) args.push("--name", name);

  try {
    const r = await runHermesCli(args, { timeoutMs: 120_000 });
    // The tree changed (or may have) — drop the cached installed list before we
    // answer, so the client's immediate re-fetch can't be served a stale walk.
    invalidateInstalledCache();
    if (r.code !== 0) {
      // Hermes is a Python CLI: an unhandled exception prints a traceback with
      // site-packages paths and local install dirs. That never reaches the
      // browser — it is logged here and the user gets a fixed message, the same
      // rule browse/inspect follow.
      console.error("[hermes skills install] exit", r.code, r.stderr);
      return NextResponse.json({ error: "Install failed" }, { status: 502 });
    }
    // Hermes' resolver can exit 0 while installing nothing (a bare id with no
    // exact match prints a "did you mean…" / disambiguation table instead).
    // Confirm the skill actually landed in the hub lock before reporting
    // success — every accepted id is a registry identifier, so it always keys
    // on a name we can check.
    const skillName = id.split("/").pop() || id;
    const landed = await isInHubLock(skillName, id);
    if (!landed) {
      return NextResponse.json(
        { error: "Skill could not be resolved — try the full identifier" },
        { status: 502 },
      );
    }
    // Return the resolved lock key: it's the argument `uninstall` needs, and
    // returning it lets the client update its state without re-deriving a name.
    const lockName = (await resolveLockKey(id)) || skillName;
    return NextResponse.json({ ok: true, id, name: lockName });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes install failed" },
      { status: 502 },
    );
  }
}

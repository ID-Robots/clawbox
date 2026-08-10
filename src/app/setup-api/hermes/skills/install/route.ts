export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { checkInstallIdentifier, isValidMeta } from "@/lib/hermes-skills";
import { isInHubLock, hermesSkillsGuard } from "@/lib/hermes-skills-server";

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
    if (r.code !== 0) {
      return NextResponse.json({ error: r.stderr || "Install failed" }, { status: 502 });
    }
    // Hermes' resolver can exit 0 while installing nothing (a bare id with no
    // exact match prints a "did you mean…" suggestion). Confirm the skill
    // actually landed in the hub lock before reporting success. URL installs
    // may key on a name we don't know here, so skip the check for those.
    if (!idCheck.isUrl) {
      const skillName = id.split("/").pop() || id;
      const landed = await isInHubLock(skillName, id);
      if (!landed) {
        return NextResponse.json(
          { error: "Skill could not be resolved — try the full identifier" },
          { status: 502 },
        );
      }
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes install failed" },
      { status: 502 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { openclawAppsGuard } from "@/lib/openclaw-apps-server";
import { readSkillEnabled } from "@/lib/openclaw-config";
import { findSkill, listSkills, SkillListUnavailableError } from "@/lib/openclaw-skill-info";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // The App Store is OpenClaw-only; refuse on a Hermes device (the UI hides
  // it, this makes HTTP agree). See src/lib/openclaw-apps-server.ts.
  const blocked = await openclawAppsGuard();
  if (blocked) return blocked;

  const appId = request.nextUrl.searchParams.get("appId");
  try {
    if (appId) {
      // Same shape rule as the settings and install routes: findSkill stats a
      // path built from appId, so "../.." would probe directories outside the
      // skills tree (and any id that stats as a directory forces a fresh
      // multi-second rescan). Answered like a skill that does not exist.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) {
        return NextResponse.json({ error: "Skill not found", code: "not_installed" }, { status: 404 });
      }
      const skill = await findSkill(appId);
      // `code` is what lets the installed-app window tell a skill that is gone
      // from the box apart from the Hermes guard's 404 (`not_openclaw`) and
      // from the 503 below — it used to show all three as "works out of the
      // box".
      if (!skill) return NextResponse.json({ error: "Skill not found", code: "not_installed" }, { status: 404 });
      // `enabled` is read from openclaw.json, not from the scan's `disabled`:
      // the scan can be a refresh old, and the switch just wrote the file.
      return NextResponse.json({ ...skill, enabled: await readSkillEnabled(appId) });
    }
    return NextResponse.json(await listSkills());
  } catch (err) {
    // Not an empty list: with nothing cached, an empty list would turn every
    // installed app into "Skill not found" while the CLI was the thing that
    // failed.
    if (err instanceof SkillListUnavailableError) {
      return NextResponse.json({ error: "Skill list unavailable", code: "skills_unavailable" }, { status: 503 });
    }
    console.error("[skill-info] Failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load skill info" }, { status: 500 });
  }
}

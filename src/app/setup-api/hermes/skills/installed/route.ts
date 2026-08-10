export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { enumerateInstalledSkills, hermesSkillsGuard } from "@/lib/hermes-skills-server";

// Installed-skill enumeration for the store's "Installed" tab and for marking
// search results as already installed. Reads disk (lock.json + the SKILL.md
// walk) rather than parsing the table-only `hermes skills list` output.
export async function GET() {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  try {
    const skills = await enumerateInstalledSkills();
    return NextResponse.json({ skills });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not read installed skills" },
      { status: 500 },
    );
  }
}

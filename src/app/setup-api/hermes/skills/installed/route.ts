export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { enumerateInstalledSkills, hermesSkillsGuard } from "@/lib/hermes-skills-server";
import { cliFailureCode } from "@/lib/hermes-skills";

// Installed-skill enumeration for the store's "Installed" tab and for marking
// browse results as already installed. Reads disk (lock.json + the SKILL.md
// walk + .bundled_manifest) rather than parsing the table-only `hermes skills
// list` output.
//
// Alongside the list it returns the counts and category facet the tab needs, so
// the client never derives them from a partially-loaded list.
export async function GET() {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  try {
    const skills = await enumerateInstalledSkills();
    const categories = new Map<string, number>();
    // `disabled` is counted alongside the origins so the tab can say how many
    // of the installed skills are actually live. It used to be a hardcoded
    // `enabled: true` on every row, which made the MCP tool's "disabled" mark
    // unreachable and told the agent a switched-off skill was available.
    const counts = { total: skills.length, builtin: 0, hub: 0, local: 0, incompatible: 0, disabled: 0 };
    for (const s of skills) {
      categories.set(s.category, (categories.get(s.category) || 0) + 1);
      counts[s.origin]++;
      if (s.incompatible) counts.incompatible++;
      if (s.enabled === false) counts.disabled++;
    }
    return NextResponse.json({
      skills,
      counts,
      categories: Array.from(categories.entries())
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    });
  } catch (err) {
    // The try covers the SKILL.md walk, the lock read and a `hermes config get`
    // — an I/O failure here names absolute device paths, and the raw message
    // was painted as the Installed tab's hint. Same rule as every other route
    // in this family: a fixed sentence and a CLASSIFIED code out, the reason to
    // the log. Classified, not hard-coded `cli_failed`: the config read reaches
    // `runHermesCli`, so a device with no `hermes` throws "not installed" here,
    // and that is the one code the MCP maps to "do not retry".
    const code = cliFailureCode(err);
    console.error("[hermes skills installed] read failed", code, err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Could not read the installed skills on this device.", code },
      { status: 500 },
    );
  }
}
